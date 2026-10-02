/* ============================================================
   scripts/browser-e2-formal-style-test.js — 正式生图（内置/自定义）请求拦截检查
   ------------------------------------------------------------
   ⚠️ 口径：本机 headless Edge + 本地静态服务 + page.route 拦截，
   全程不调付费接口；夹具接口 baseUrl 用不可达的 127.0.0.1:9 双保险。
   验证（施工单 v1 §八最小覆盖的请求侧）：
     F1 设置页「视觉层（正式生图）」：内置/自定义切换、custom 框显隐、
        切换不清空原文、空 custom 提示
     F2 generate({plan}) 真实走正式拼接器（builtin male/female、custom、
        custom 空）→ 请求正文断言（chat 通道 + general 通道）
     F3 校验拦截：重复引用 / 预期人数对账 / 超 4 人 / 0人报person →
        ok:false 且请求数不增加
     F4 NAI 回落 legacy（既有能力），不冒充新词生效
     F5 生成后改配置不影响已发请求（快照语义：配置在 generate 时刻读取）
   run:
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e2-formal-style-test.js
   ============================================================ */
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

const PORT = process.env.E2_FORMAL_PORT || 5222;
const BASE = 'http://127.0.0.1:' + PORT;
const results = [];
function chk(name, cond, extra) {
  results.push({ name, ok: !!cond });
  if (!cond) console.error('  ✗ ' + name + (extra ? '  ' + extra : ''));
  else console.log('  ✓ ' + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countOf = (s, n) => String(s || '').split(n).length - 1;

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

async function waitApp(page) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
  await page.waitForFunction(() => {
    const S = window.Sleepy;
    return !!(S && S.nav && S.core && S.nav.open);
  }, { timeout: 15000 });
  await sleep(600);
  return errs;
}

/* 1x1 PNG（chat 通道回 markdown 内嵌，走完 extractImageFromChatText 落地链） */
const PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let genCount = 0, chatCount = 0, naiCount = 0;
  let capturedGeneral = null, capturedChat = null, capturedNai = null;
  let failed = 0;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.route('**/images/generations', async (route) => {
      genCount++;
      try { capturedGeneral = JSON.parse(route.request().postData() || '{}'); } catch (e) { capturedGeneral = null; }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ b64_json: PX_PNG }] }) });
    });
    await page.route('**/chat/completions', async (route) => {
      chatCount++;
      try { capturedChat = JSON.parse(route.request().postData() || '{}'); } catch (e) { capturedChat = null; }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '![img](data:image/png;base64,' + PX_PNG + ')' } }] }) });
    });
    await page.route('**/ai/generate-image', async (route) => {
      naiCount++;
      try { capturedNai = JSON.parse(route.request().postData() || '{}'); } catch (e) { capturedNai = null; }
      await route.fulfill({ status: 200, contentType: 'application/zip',
        body: Buffer.from('PK\x03\x04' + '0'.repeat(40)) });
    });

    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const errs = await waitApp(page);
    chk('F0 启动无 pageerror', errs.length === 0, errs.join(' | '));

    /* ---- 夹具：虚构角色（不写私人资料）---- */
    const chId = await page.evaluate(() => {
      const c = window.Sleepy.core.upsertChar({
        name: '正式链路角色A', kind: 'main', gender: 'female',
        faceLockText: '银发, 红瞳, 齐肩发', faceLockSelfie: '自拍时比剪刀手', faceLockFull: '白裙'
      });
      return c.id;
    });

    /* ========== F1 设置页 UI ========== */
    await page.evaluate(() => { window.Sleepy.nav.open('settings-imggen'); });
    await sleep(500);
    const ui1 = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      const sel = Array.from(pg.querySelectorAll('select')).find((s) => {
        const w = s.closest('.set-field');
        return w && (w.querySelector('.set-label') || {}).textContent === '视觉层';
      });
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('自定义视觉词') === 0;
      });
      return { sel: sel ? sel.value : null, ta: !!ta, taVisible: !!ta && ta.offsetParent !== null,
        text: pg.textContent || '' };
    });
    chk('F1 视觉层下拉存在且默认内置', ui1.sel === 'builtin', String(ui1.sel));
    chk('F1 内置档不露自定义框（内置词不提供编辑）', ui1.ta && !ui1.taVisible);
    chk('F1 内置档提示「暂不提供编辑」', ui1.text.indexOf('内置词暂不提供编辑') >= 0);

    /* 切到 custom：框露面；写原文 → 切回内置 → 再切回来原文还在 */
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      const sel = Array.from(pg.querySelectorAll('select')).find((s) => {
        const w = s.closest('.set-field');
        return w && (w.querySelector('.set-label') || {}).textContent === '视觉层';
      });
      sel.value = 'custom';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);
    const ui2 = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('自定义视觉词') === 0;
      });
      if (ta) {
        ta.value = 'flat graphic illustration, limited 6-color palette';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { taVisible: !!ta && ta.offsetParent !== null,
        saved: window.Sleepy.imggen.imgStyleCustom() };
    });
    chk('F1 custom 档露框且原文落库', ui2.taVisible && ui2.saved === 'flat graphic illustration, limited 6-color palette');
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      const sel = Array.from(pg.querySelectorAll('select')).find((s) => {
        const w = s.closest('.set-field');
        return w && (w.querySelector('.set-label') || {}).textContent === '视觉层';
      });
      sel.value = 'builtin';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return null;
    });
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      const sel = Array.from(pg.querySelectorAll('select')).find((s) => {
        const w = s.closest('.set-field');
        return w && (w.querySelector('.set-label') || {}).textContent === '视觉层';
      });
      sel.value = 'custom';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);
    const kept = await page.evaluate(() => window.Sleepy.imggen.imgStyleCustom());
    chk('F1 切换不清空自定义原文', kept === 'flat graphic illustration, limited 6-color palette', kept);

    /* 空原文提示：清空后提示「未添加自定义视觉词」 */
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('自定义视觉词') === 0;
      });
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(150);
    const ui3 = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      return (pg.textContent || '').indexOf('未添加自定义视觉词') >= 0;
    });
    chk('F1 空 custom 提示「未添加自定义视觉词」', ui3);

    /* ========== F2/F3 generate({plan}) 请求级验证 ========== */
    const genApi = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('general');
      a.name = '正式-General'; a.baseUrl = 'http://127.0.0.1:9/v1'; a.model = 'formal-general';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a])); g.setCurrent(a.id);
      return a.id;
    });
    const chatApi = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('chat');
      a.name = '正式-Chat'; a.baseUrl = 'http://127.0.0.1:9/v1'; a.model = 'formal-chat';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a]));
      return a.id;
    });
    const naiApi = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('nai');
      a.name = '正式-NAI'; a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a]));
      return a.id;
    });
    await page.evaluate((id) => { window.Sleepy.imggen.setCurrent(id); }, genApi);

    /* 恢复 custom 原文用于 F2（上一步清空了），并把视觉层显式切回内置
       （F1 结束时停在 custom 档 —— 状态要显式摆好，别依赖上一节的尾巴） */
    await page.evaluate(() => {
      window.Sleepy.imggen.setImgStyleCustom('flat graphic illustration, limited 6-color palette');
      window.Sleepy.imggen.setImgStyleMode('builtin');
    });

    async function gen(plan, apiId) {
      const r = await page.evaluate(async (p) => {
        const api = window.Sleepy.imggen.listApis().find((x) => x.id === p.apiId);
        const r = await window.Sleepy.imggen.generate({ plan: p.plan, api: api });
        return { ok: r.ok, msg: r.error ? r.error.message : '' };
      }, { plan, apiId });
      await sleep(250);
      return r;
    }

    /* F2a builtin female 单人（general 通道） */
    capturedGeneral = null;
    const baseCount0 = genCount;
    const r1 = await gen({ sender: 'user', contentType: 'person', shot: 'full',
      subjects: [{ entityType: 'char', entityId: chId, name: '正式链路角色A', gender: 'female',
        faceText: '银发, 红瞳, 白裙' }], description: '站在海边，白天' }, genApi);
    chk('F2a builtin 女C 单人（general）发出请求', r1.ok === true && genCount === baseCount0 + 1, JSON.stringify(r1));
    chk('F2a 正文带女C胜出词/单人结构/身份段/描述',
      capturedGeneral && capturedGeneral.prompt.indexOf('strikingly beautiful female character') >= 0
      && capturedGeneral.prompt.indexOf('solo, exactly one person') >= 0
      && countOf(capturedGeneral.prompt, '银发, 红瞳, 白裙') === 1
      && capturedGeneral.prompt.indexOf('站在海边') >= 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 120));
    chk('F2a 独立 negative_prompt = 质量+单人结构、无审美负面',
      capturedGeneral && capturedGeneral.negative_prompt.indexOf('extra person') >= 0
      && capturedGeneral.negative_prompt.indexOf('plastic skin') < 0,
      capturedGeneral && capturedGeneral.negative_prompt);

    /* F2b chat 通道：同一 plan → 自然语言正文；负面成句 */
    capturedChat = null;
    const chatCount0 = chatCount;
    const r2 = await gen({ sender: 'char', contentType: 'person', shot: 'selfie',
      subjects: [{ entityType: 'char', entityId: chId, name: '正式链路角色A', gender: 'female',
        faceText: '银发, 红瞳' }], description: '对镜自拍' }, chatApi);
    chk('F2b chat 通道发出请求', r2.ok === true && chatCount === chatCount0 + 1, JSON.stringify(r2));
    const content = capturedChat && capturedChat.messages && capturedChat.messages[0] ? capturedChat.messages[0].content : '';
    chk('F2b 正文带女C词 + 自拍镜头层 + 锁脸，负面成自然语言句',
      content.indexOf('请生成一张图片：') === 0
      && content.indexOf('strikingly beautiful female character') >= 0
      && content.indexOf('close-up selfie shot') >= 0
      && content.indexOf('银发, 红瞳') >= 0
      && content.indexOf('画面里不要出现这些要素：') >= 0,
      content && content.slice(0, 140));

    /* F2c custom 模式：正文带用户词、无内置审美词 */
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleMode('custom'); });
    capturedGeneral = null;
    const r3 = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [{ entityType: 'char', entityId: chId, name: '正式链路角色A', gender: 'female', faceText: '银发' }],
      description: '站在院子里' }, genApi);
    chk('F2c custom 正文带用户词、不混内置审美',
      r3.ok === true && capturedGeneral
      && capturedGeneral.prompt.indexOf('flat graphic illustration') >= 0
      && capturedGeneral.prompt.indexOf('strikingly beautiful female character') < 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 120));

    /* F2d custom 空：合法，结构与质量层保留，不回退内置 */
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleCustom(''); });
    capturedGeneral = null;
    const r4 = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [{ entityType: 'char', entityId: chId, name: '正式链路角色A', gender: 'female', faceText: '银发' }],
      description: '站在院子里' }, genApi);
    chk('F2d 空 custom 合法：结构/身份在、无内置审美词',
      r4.ok === true && capturedGeneral
      && capturedGeneral.prompt.indexOf('solo, exactly one person') >= 0
      && capturedGeneral.prompt.indexOf('银发') >= 0
      && capturedGeneral.prompt.indexOf('strikingly beautiful female character') < 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 120));
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleMode('builtin'); });

    /* F3 校验拦截（请求零增加） */
    const genBefore = genCount, chatBefore = chatCount;
    const dup = await gen({ sender: 'user', contentType: 'person', subjects: [
      { entityType: 'char', entityId: chId, name: 'A', gender: 'female', faceText: '' },
      { entityType: 'char', entityId: chId, name: 'A', gender: 'female', faceText: '' }],
      description: 'x' }, genApi);
    chk('F3a 重复引用拦截且零请求', dup.ok === false && dup.msg.indexOf('重复') >= 0 && genCount === genBefore, JSON.stringify(dup));
    const lack = await gen({ sender: 'user', contentType: 'person',
      subjects: [{ entityType: 'char', entityId: chId, name: 'A', gender: 'female', faceText: '' }],
      description: 'x', expectedSubjectCount: 2 }, genApi);
    chk('F3b 预期人数对账拦截', lack.ok === false && lack.msg.indexOf('解析不了') >= 0 && genCount === genBefore, JSON.stringify(lack));
    const five = [1, 2, 3, 4, 5].map((i) => ({ entityType: 'char', entityId: 'fx' + i, name: '人' + i, gender: 'female', faceText: '' }));
    const over = await gen({ sender: 'user', contentType: 'mixed', subjects: five, description: 'x' }, genApi);
    chk('F3c 超 4 人拦截', over.ok === false && over.msg.indexOf('最多') >= 0 && genCount === genBefore, JSON.stringify(over));
    const ghost = await gen({ sender: 'user', contentType: 'person', subjects: [], description: 'x' }, genApi);
    chk('F3d 0人报person拦截', ghost.ok === false && ghost.msg.indexOf('没解析出来') >= 0 && genCount === genBefore, JSON.stringify(ghost));

    /* F4 NAI 正式接线（2026-10-02 施工单）：接口模型未配置 → 明确报错零请求，
       不再回落 legacy 照发。 */
    capturedNai = null;
    const naiBefore = naiCount;
    const r5 = await gen({ sender: 'user', contentType: 'person', shot: 'full',
      subjects: [{ entityType: 'char', entityId: chId, name: '正式链路角色A', gender: 'female', faceText: '银发' }],
      description: 'NAI 正式接线检查' }, naiApi);
    chk('F4 NAI 模型未配置 → 报错零请求（不回落 legacy）',
      r5.ok === false && r5.msg.indexOf('模型') >= 0 && naiCount === naiBefore,
      JSON.stringify({ ok: r5.ok, msg: r5.msg, naiCount }));
    chk('F4 NAI 报错指明支持的模型名单',
      r5.msg.indexOf('没配好') >= 0 || r5.msg.indexOf('不支持') >= 0
      || (r5.msg.indexOf('模型') >= 0), r5.msg);

    /* F5 配置快照语义：generate 内部读配置一次，之后改配置不影响已在途请求
       （用两次请求对比：改配置后再发，内容跟着新配置走；旧请求已完成不受影响） */
    await page.evaluate((id) => { window.Sleepy.imggen.setCurrent(id); }, genApi);
    capturedGeneral = null;
    await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [{ entityType: 'char', entityId: chId, name: '正式链路角色A', gender: 'female', faceText: '' }],
      description: '快照语义A' }, genApi);
    const beforeA = capturedGeneral ? capturedGeneral.prompt : '';
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleMode('custom'); });
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleCustom('marker-custom-style'); });
    capturedGeneral = null;
    await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [{ entityType: 'char', entityId: chId, name: '正式链路角色A', gender: 'female', faceText: '' }],
      description: '快照语义B' }, genApi);
    const afterB = capturedGeneral ? capturedGeneral.prompt : '';
    chk('F5 改配置后新请求按新配置走（旧请求内容不变）',
      beforeA.indexOf('strikingly beautiful female character') >= 0
      && afterB.indexOf('marker-custom-style') >= 0
      && afterB.indexOf('strikingly beautiful female character') < 0);
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleMode('builtin'); });

    failed = results.filter((r) => !r.ok).length;
    console.log('\n结果：' + results.filter((r) => r.ok).length + ' ✓ / ' + failed + ' ✗'
      + '（拦截计数 general=' + genCount + ' chat=' + chatCount + ' nai=' + naiCount + '）');
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
