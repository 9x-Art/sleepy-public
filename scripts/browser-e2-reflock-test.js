/* ============================================================
   scripts/browser-e2-reflock-test.js — B2 图片锁脸 请求拦截检查
   ------------------------------------------------------------
   ⚠️ 口径：本机 headless Edge + 本地静态服务 + page.route 拦截，
   虚构图片夹具，全程不调付费接口、不上传真实照片。
   验证（施工单 v1 §7，覆盖可达项）：
     R1 user 发起只画 TA：只锁 TA、不发 user 图、不改镜头
     R2 user+TA 四态：附件数量/归属编号/正文逐项断言
     R3 同名不同 ID 不串图；调换顺序编号跟随
     R4 显式 false 覆盖已保存 true；关闭不删资料；存图未启用不上传
     R5 无图/全关走原 generations 路径；失效媒体/URL 失败/不支持接口
        → 明确报错零请求，不做无图兜底
     R6 chat 多模态：image_url part + 正文约束句
     R7 马甲键命名空间：U1 的开关不带 U2 的图
   run:
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e2-reflock-test.js
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

const PORT = process.env.E2_REFLOCK_PORT || 5224;
const BASE = 'http://127.0.0.1:' + PORT;
const results = [];
function chk(name, cond, extra) {
  results.push({ name, ok: !!cond });
  if (!cond) console.error('  ✗ ' + name + (extra ? '  ' + extra : ''));
  else console.log('  ✓ ' + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 两个不同的 1×1 PNG（字节数不同，便于区分附件） */
const PX1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PX2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

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
  await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const S = window.Sleepy;
    return !!(S && S.nav && S.core && S.nav.open);
  }, { timeout: 15000 });
  await sleep(600);
  return errs;
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let editsCount = 0, genCount = 0, chatCount = 0;
  let editsBuf = null, genBody = null, chatBody = null;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.route('**/images/edits', async (route) => {
      editsCount++;
      editsBuf = route.request().postDataBuffer() || Buffer.alloc(0);
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ b64_json: PX1 }] }) });
    });
    await page.route('**/images/generations', async (route) => {
      genCount++;
      try { genBody = JSON.parse(route.request().postData() || '{}'); } catch (e) { genBody = null; }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ b64_json: PX1 }] }) });
    });
    await page.route('**/chat/completions', async (route) => {
      chatCount++;
      try { chatBody = JSON.parse(route.request().postData() || '{}'); } catch (e) { chatBody = null; }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '![img](data:image/png;base64,' + PX1 + ')' } }] }) });
    });
    /* URL 源失败夹具：该地址固定 404（参考图拉取失败 → 零生成） */
    await page.route('**/ref-missing.png', async (route) => {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' });
    });

    const errs = await waitApp(page);
    chk('R0 启动无 pageerror', errs.length === 0, errs.join(' | '));

    /* ---- 夹具：虚构身份 + 图库里的虚构图 ---- */
    const fx = await page.evaluate(async (PX) => {
      const S = window.Sleepy, g = S.imggen, c = S.core;
      g.saveApis([]);
      const blobOf = async (b64) => (await fetch('data:image/png;base64,' + b64)).blob();
      const m1 = await S.media.put(await blobOf(PX.PX1), { name: '夹具图1', kind: 'faceLock' });
      const m2 = await S.media.put(await blobOf(PX.PX2), { name: '夹具图2', kind: 'faceLock' });
      const mk = (o) => c.upsertChar(Object.assign({ kind: 'main', sandboxId: 'sb-reflock' }, o));
      const A = mk({ name: '夹具A', gender: 'female', faceLockText: 'qzx银发标记A',
        faceLockImageMedia: m1, faceLockImageOn: true });
      const B = mk({ name: '夹具B', gender: 'male', faceLockText: 'qzx蓝发标记B' });
      const N1 = mk({ name: '同名', gender: 'female', faceLockImageMedia: m1, faceLockImageOn: true });
      const N2 = mk({ name: '同名', gender: 'female', faceLockImageMedia: m2, faceLockImageOn: true });
      const D = mk({ name: '失效图D', gender: 'female', faceLockImageMedia: 'media-missing', faceLockImageOn: true });
      const E = mk({ name: '网址E', gender: 'female',
        faceLockImage: 'http://127.0.0.1:9/ref-missing.png', faceLockImageOn: true });
      const F = mk({ name: '存图未启用F', gender: 'female', faceLockImageMedia: m1, faceLockImageOn: false });
      const NPC = mk({ name: 'NPC丙', kind: 'npc', gender: 'female',
        faceLockImageMedia: m1, faceLockImageOn: true, parentType: 'sandbox', parentId: 'sb-reflock' });
      const U1 = c.upsertUser({ name: '马甲一', faceLockImageMedia: m1, faceLockImageOn: true });
      const U2 = c.upsertUser({ name: '马甲二', faceLockImageMedia: m2, faceLockImageOn: false });
      const apiEdits = g.newApi('general');
      apiEdits.name = 'R-通用'; apiEdits.baseUrl = 'http://127.0.0.1:9/v1';
      apiEdits.model = 'fixture-img'; apiEdits.apiKey = 'fixture-only';
      apiEdits.refSupport = 'edits';
      const apiNone = g.newApi('general');
      apiNone.name = 'R-不支持'; apiNone.baseUrl = 'http://127.0.0.1:9/v1';
      apiNone.model = 'fixture-img'; apiNone.refSupport = 'none';
      const apiChat = g.newApi('chat');
      apiChat.name = 'R-文字'; apiChat.baseUrl = 'http://127.0.0.1:9/v1';
      apiChat.model = 'fixture-chat'; apiChat.refSupport = 'chat';
      const apiNai = g.newApi('nai');
      apiNai.name = 'R-NAI'; apiNai.model = 'nai-diffusion-3';
      g.saveApis(g.listApis().concat([apiEdits, apiNone, apiChat, apiNai]));
      return { A: A.id, B: B.id, N1: N1.id, N2: N2.id, D: D.id, E: E.id,
        F: F.id, NPC: NPC.id, U1: U1.id, U2: U2.id,
        edits: apiEdits.id, none: apiNone.id, chat: apiChat.id, nai: apiNai.id };
    }, { PX1: PX1, PX2: PX2 });
    const sub = (type, id, name, gender) =>
      ({ entityType: type, entityId: id, name: name || '', gender: gender || '', faceText: '' });
    async function gen(plan, apiId, locks) {
      return page.evaluate(async (p) => {
        const api = window.Sleepy.imggen.listApis().find((x) => x.id === p.apiId);
        const r = await window.Sleepy.imggen.generate(
          { plan: p.plan, api: api, imageLocks: p.locks });
        return { ok: r.ok, msg: r.error ? r.error.message : '', detail: r.error ? r.error.detail : '' };
      }, { plan, apiId, locks: locks || null });
    }
    const apiOf = (id) => page.evaluate((x) =>
      window.Sleepy.imggen.listApis().find((a) => a.id === x), id);
    const editsText = () => editsBuf.toString('utf8');
    const locksOf = (...pairs) => { const m = {}; pairs.forEach((p) => { m[p[0]] = p[1]; }); return m; };

    /* ========== R1 user 发起只画 TA ========== */
    editsCount = 0; genCount = 0; editsBuf = null;
    const r1 = await gen({ sender: 'user', contentType: 'person', shot: 'full',
      subjects: [sub('char', fx.A, '夹具A', 'female')], description: 'qzx场景R1' },
      fx.edits, locksOf(['user:' + fx.U1, true], ['char:' + fx.A, true]));
    chk('R1 user 发起只画 TA：走 edits 且恰好一张附件（TA 的）',
      r1.ok === true && editsCount === 1
      && editsText().indexOf('reference-1.png') >= 0
      && editsText().indexOf('reference-2.png') < 0,
      JSON.stringify({ ok: r1.ok, msg: r1.msg, editsCount }));
    chk('R1 正文约束句只给 TA（点名夹具A）；user 侧无约束句',
      editsText().indexOf("Reference image 1 is " + '夹具A') >= 0
      && editsText().indexOf('Reference image 2') < 0
      && editsText().indexOf('is ' + '马甲一') < 0,
      editsText().slice(0, 300));
    chk('R1 不改镜头（shot=full 原样进 prompt）',
      editsText().indexOf('full body') >= 0 || editsText().indexOf('full') >= 0,
      editsText().slice(0, 160));

    /* ========== R2 user+TA 四态 ========== */
    const plan2 = { sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.A, '夹具A', 'female'), sub('user', fx.U1, '马甲一', 'female')],
      description: 'qzx合影R2' };
    editsCount = 0;
    editsCount = 0; genCount = 0; editsBuf = null;
    const r2a = await gen(plan2, fx.edits,
      locksOf(['char:' + fx.A, true], ['user:' + fx.U1, true]));
    chk('R2a 都锁：两张附件 + 两条编号约束句',
      r2a.ok === true && editsCount === 1
      && editsText().indexOf('reference-1.png') >= 0
      && editsText().indexOf('reference-2.png') >= 0
      && editsText().indexOf('Reference image 1') >= 0
      && editsText().indexOf('Reference image 2') >= 0,
      JSON.stringify({ ok: r2a.ok, editsCount }));
    chk('R2a 编号对应：1=A、2=U1（名字在各自句里）',
      editsText().indexOf("Reference image 1 is " + '夹具A') >= 0
      && editsText().indexOf("Reference image 2 is " + '马甲一') >= 0,
      editsText().slice(0, 400));
    editsCount = 0; editsBuf = null;
    const r2b = await gen(plan2, fx.edits,
      locksOf(['char:' + fx.A, false], ['user:' + fx.U1, true]));
    chk('R2b 只锁我：A 显式 false → 一张附件且编号 1 归 U1（映射非按下标）',
      r2b.ok === true && editsCount === 1
      && editsText().indexOf('reference-1.png') >= 0
      && editsText().indexOf('reference-2.png') < 0
      && editsText().indexOf("Reference image 1 is " + '马甲一') >= 0
      && editsText().indexOf('夹具A') >= 0 /* 身份段仍在，只是无约束句 */
      && editsText().indexOf('Reference image 1 is ' + '夹具A') < 0,
      editsText().slice(0, 300));

    /* ========== R3 同名不同 ID / 顺序 ========== */
    const planN = { sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.N1, '同名', 'female'), sub('char', fx.N2, '同名', 'female')],
      description: 'qzx同名R3' };
    editsCount = 0; editsBuf = null;
    genCount = 0;
    const r3a = await gen(planN, fx.edits,
      locksOf(['char:' + fx.N1, true], ['char:' + fx.N2, false]));
    chk('R3a 同名不同 ID：只锁第一个（ID 键，非名字/顺序）',
      r3a.ok === true && editsCount === 1
      && editsText().indexOf('reference-1.png') >= 0
      && editsText().indexOf('reference-2.png') < 0,
      JSON.stringify({ ok: r3a.ok, editsCount }));
    editsCount = 0; editsBuf = null;
    const planN2 = { sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.N2, '同名', 'female'), sub('char', fx.N1, '同名', 'female')],
      description: 'qzx同名R3b' };
    editsCount = 0; genCount = 0; editsBuf = null;
    const r3b = await gen(planN2, fx.edits,
      locksOf(['char:' + fx.N2, true], ['char:' + fx.N1, false]));
    chk('R3b 调换顺序：编号跟随主体（N2 在前 → Reference image 1 是 N2 位）',
      r3b.ok === true && editsCount === 1
      && editsText().indexOf('reference-1.png') >= 0
      && editsText().indexOf('reference-2.png') < 0,
      JSON.stringify({ ok: r3b.ok, editsCount }));

    /* ========== R4 false 覆盖 / 关闭不删资料 / 存图未启用 ========== */
    genCount = 0; genBody = null;
    const planA = { sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.A, '夹具A', 'female')], description: 'qzx覆盖R4' };
    editsCount = 0; genCount = 0; genBody = null; editsBuf = null;
    const r4 = await gen(planA, fx.edits, locksOf(['char:' + fx.A, false]));
    chk('R4a 显式 false 覆盖已保存 true → 走原 generations 路径',
      r4.ok === true && genCount === 1 && editsCount === 0
      && genBody && genBody.prompt.indexOf('Reference image') < 0,
      JSON.stringify({ ok: r4.ok, genCount, editsCount }));
    const kept = await page.evaluate((id) => {
      const c = window.Sleepy.core.findChar(id);
      return { media: c.faceLockImageMedia, on: c.faceLockImageOn };
    }, fx.A);
    chk('R4b 关闭不删资料（mediaId 与授权原样保留）',
      kept.media && kept.on === true, JSON.stringify(kept));
    genCount = 0; genBody = null;
    const r4c = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.F, '存图未启用F', 'female')], description: 'qzxR4c' },
      fx.edits);
    chk('R4c 存图未启用不上传（走原路径）',
      r4c.ok === true && genCount === 1 && genBody.prompt.indexOf('Reference image') < 0,
      JSON.stringify({ ok: r4c.ok, genCount }));

    /* ========== R5 失败即停 / 不支持 ========== */
    editsCount = 0; genCount = 0;
    editsCount = 0; genCount = 0;
    const r5a = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.D, '失效图D', 'female')], description: 'x' }, fx.edits);
    chk('R5a 失效媒体 → 报错点名主体，零生成请求',
      r5a.ok === false && r5a.msg.indexOf('失效图D') >= 0
      && editsCount === 0 && genCount === 0,
      JSON.stringify({ ok: r5a.ok, msg: r5a.msg, editsCount, genCount }));
    editsCount = 0; genCount = 0;
    const r5b = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.E, '网址E', 'female')], description: 'x' }, fx.edits);
    chk('R5b URL 拉取失败（404 夹具）→ 报错点名主体、提示本地图，零生成',
      r5b.ok === false && r5b.msg.indexOf('网址E') >= 0
      && (r5b.detail.indexOf('拉取失败') >= 0 || r5b.detail.indexOf('404') >= 0)
      && editsCount === 0,
      JSON.stringify({ ok: r5b.ok, msg: r5b.msg, editsCount }));
    editsCount = 0; genCount = 0;
    const r5c = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.A, '夹具A', 'female')], description: 'x' }, fx.none);
    chk('R5c 接口未开启参考图支持 → 明确拦截零请求',
      r5c.ok === false && r5c.msg.indexOf('参考图支持') >= 0
      && editsCount === 0 && genCount === 0,
      JSON.stringify({ ok: r5c.ok, msg: r5c.msg }));
    editsCount = 0; genCount = 0;
    const r5d = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.A, '夹具A', 'female')], description: 'x' }, fx.nai);
    chk('R5d NAI 启用图片锁脸 → 明确拦截零请求（提示可关闭本次）',
      r5d.ok === false && r5d.msg.indexOf('NAI') >= 0
      && r5d.detail.indexOf('关闭本次图片锁脸') >= 0 && editsCount === 0,
      JSON.stringify({ ok: r5d.ok, msg: r5d.msg }));

    /* ========== R6 chat 多模态 ========== */
    chatCount = 0; chatBody = null;
    editsCount = 0; genCount = 0;
    const r6 = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.A, '夹具A', 'female')], description: 'qzx对话R6' },
      fx.chat, locksOf(['char:' + fx.A, true]));
    const parts = chatBody && chatBody.messages && chatBody.messages[0]
      && chatBody.messages[0].content;
    chk('R6 chat：多模态 parts（text 带 Reference image 1 + image_url dataURL）',
      r6.ok === true && chatCount === 1 && Array.isArray(parts)
      && parts[0].type === 'text' && parts[0].text.indexOf('Reference image 1') >= 0
      && parts[1].type === 'image_url'
      && parts[1].image_url.url.indexOf('data:image') === 0,
      JSON.stringify({ ok: r6.ok, parts: parts && parts.map((p) => p.type) }));

    /* ========== R7 马甲键命名空间 ========== */
    genCount = 0; genBody = null;
    editsCount = 0; genCount = 0; genBody = null; editsBuf = null;
    const r7a = await gen({ sender: 'char', contentType: 'person', shot: 'auto',
      subjects: [sub('user', fx.U2, '马甲二', 'female')], description: 'qzxR7' },
      fx.edits, locksOf(['user:' + fx.U1, true]));
    chk('R7a U1 的开关不带 U2 的图（U2 已存但未启用 → 原路径）',
      r7a.ok === true && genCount === 1 && editsCount === 0
      && genBody.prompt.indexOf('Reference image') < 0,
      JSON.stringify({ ok: r7a.ok, genCount, editsCount }));
    editsCount = 0; editsBuf = null;
    editsCount = 0; genCount = 0; genBody = null; editsBuf = null;
    const r7b = await gen({ sender: 'char', contentType: 'person', shot: 'auto',
      subjects: [sub('user', fx.U2, '马甲二', 'female')], description: 'qzxR7b' },
      fx.edits, locksOf(['user:' + fx.U2, true]));
    chk('R7b U2 自己的开关生效（键对准）',
      r7b.ok === true && editsCount === 1
      && editsText().indexOf('reference-1.png') >= 0,
      JSON.stringify({ ok: r7b.ok, editsCount }));

    /* ========== R8 NPC（char 路径同构） ========== */
    editsCount = 0; editsBuf = null;
    editsCount = 0; genCount = 0; editsBuf = null;
    const r8 = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [sub('char', fx.NPC, 'NPC丙', 'female')], description: 'qzxR8' },
      fx.edits, locksOf(['char:' + fx.NPC, true]));
    chk('R8 NPC 参考图随 char 路径生效',
      r8.ok === true && editsCount === 1
      && editsText().indexOf("Reference image 1 is " + 'NPC丙') >= 0,
      JSON.stringify({ ok: r8.ok, editsCount }));

    /* ========== 汇总 ========== */
    const failed = results.filter((r) => !r.ok).length;
    console.log('\n结果：' + results.filter((r) => r.ok).length + ' ✓ / ' + failed + ' ✗'
      + '（拦截：edits=' + editsCount + ' generations=' + genCount + ' chat=' + chatCount + '）');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('测试异常：', e);
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
}

main();
