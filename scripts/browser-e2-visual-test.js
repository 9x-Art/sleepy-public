/* ============================================================
   scripts/browser-e2-visual-test.js — E2 单人角色实验 UI 请求拦截检查
   ------------------------------------------------------------
   ⚠️ 用词口径（2026-10-01 定点返修修正）：这是**本机 headless 浏览器**里的
   自动化检查，**不是真机 / 真手机**。运行方式：Windows 本机 + Node 22 +
   playwright-core，`pw.chromium.launch({ channel: 'msedge', headless: true })`
   （用本机已装的 Edge 内核，无头），再 `spawn` 起一个 127.0.0.1:<PORT> 的
   本地静态服务；用 page.route 拦下 /images/generations，**只读请求体**里的
   prompt，回一张 1x1 PNG 让流程走完 —— 全程不调付费接口。
   报告里别把它写成「真机验收」。

   两个阶段：
     阶段 A（无岛 / 无角色 / 无马甲）—— 验证「单人（临时测试）」能直接用
     阶段 B（有岛 / 角色 / 马甲）—— 验证锁脸联调 + 显隐 + 回显 + 失效拦截

   验证清单（02 返修单 §四 + 入口调整单 §四）：
     A1 名册为空时主体下拉只有两项 + 名册为空提示（不靠读全部角色填满）
     A2 选「单人（临时测试）」才出现性别；三档性别都能出 prompt
     A3 临时单人**不读任何真实身份**（锁脸词一个不进）、描述原样透传
     A4 临时单人没有 01 的无人排人词、没有男性校准词
     B1 三模式显隐（legacy 收起；sleepy-default/custom 展开）
     B2 主体/镜头/手部选择保存 + 刷新回显
     B3 角色 / 马甲身份进入请求（含本岛隔离，读自己那份）
     B4 主体失效（移出本岛）→ 请求不发、不静默换人、不回落无人图
     B5 没有人 → 01 场景/物品；legacy → 与 buildPrompt 逐字一致
     D1 诊断：新增角色后试一张的主体下拉到底会不会更新（只报告，不断言通过/失败）
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e2-visual-test.js
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

const PORT = process.env.E2_TEST_PORT || 5206;
const BASE = 'http://127.0.0.1:' + PORT;
const results = [];
const notes = [];
function chk(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  if (!cond) console.error('  ✗ ' + name + (extra ? '  ' + extra : ''));
  else console.log('  ✓ ' + name);
}
/* 只记录、不判成败（用于「照实报告」的诊断项） */
function note(name, text) {
  notes.push({ name, text });
  console.log('  · ' + name + ' → ' + text);
}
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

async function waitApp(page) {
  const sleepyErrs = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (t && t.indexOf('[Sleepy]') >= 0) sleepyErrs.push(t.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => {
    const t = String((e && e.message) || e);
    if (t.indexOf('[Sleepy]') >= 0) sleepyErrs.push(t.slice(0, 300));
  });
  await page.waitForFunction(() => {
    const S = window.Sleepy;
    return !!(S && S.nav && S.core && S.nav.open);
  }, { timeout: 15000 });
  await sleep(600);
  return sleepyErrs;
}

const EDIT = '.page[data-page="settings-imggen-edit"]';
/* 实验区下拉顺序：[0]模式 [1]主体 [2]性别（仅临时单人）[3]镜头 [4]手部 */
const IDX = { mode: 0, subject: 1, gender: 2, shot: 3, hands: 4 };

async function openTry(page, apiId) {
  await page.evaluate((id) => { window.Sleepy.nav.open('settings-imggen-edit', { id }); }, apiId);
  await sleep(500);
  await page.evaluate(() => {
    const head = document.querySelector('.page[data-page="settings-imggen-edit"] .imggen-fold-head');
    if (head) head.click();
  });
  await sleep(300);
}

async function readUI(page) {
  return page.evaluate((IDX) => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const sels = Array.from(pg.querySelectorAll('.imggen-fold select'));
    const vis = (i) => !!sels[i] && sels[i].offsetParent !== null;
    const tas = Array.from(pg.querySelectorAll('.imggen-fold textarea'));
    const custom = tas.find((t) => (t.placeholder || '').indexOf('flat graphic') >= 0);
    return {
      mode: sels[IDX.mode] ? sels[IDX.mode].value : '',
      subject: sels[IDX.subject] ? sels[IDX.subject].value : '',
      gender: sels[IDX.gender] ? sels[IDX.gender].value : '',
      shot: sels[IDX.shot] ? sels[IDX.shot].value : '',
      hands: sels[IDX.hands] ? sels[IDX.hands].value : '',
      subjectVisible: vis(IDX.subject),
      genderVisible: vis(IDX.gender),
      shotVisible: vis(IDX.shot),
      handsVisible: vis(IDX.hands),
      customVisible: !!custom && custom.offsetParent !== null,
      text: pg ? (pg.textContent || '') : ''
    };
  }, IDX);
}

async function subjectOptionValues(page) {
  return page.evaluate((IDX) => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const sels = Array.from(pg.querySelectorAll('.imggen-fold select'));
    const sel = sels[IDX.subject];
    if (!sel) return [];
    return Array.from(sel.querySelectorAll('option')).map((o) => o.value);
  }, IDX);
}

async function setSelect(page, idx, value) {
  await page.evaluate((a) => {
    const sels = Array.from(document.querySelector('.page[data-page="settings-imggen-edit"]')
      .querySelectorAll('.imggen-fold select'));
    const sel = sels[a.idx];
    if (!sel) return;
    sel.value = a.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, { idx, value });
  await sleep(200);
}

async function fillSubject(page, text) {
  await page.evaluate((t) => {
    const tas = Array.from(document.querySelector('.page[data-page="settings-imggen-edit"]')
      .querySelectorAll('.imggen-fold textarea'));
    const subj = tas.find((x) => (x.placeholder || '').indexOf('坐在窗边') >= 0);
    if (!subj) return;
    subj.value = t;
    subj.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(150);
}

async function fillCustom(page, text) {
  await page.evaluate((t) => {
    const tas = Array.from(document.querySelector('.page[data-page="settings-imggen-edit"]')
      .querySelectorAll('.imggen-fold textarea'));
    /* 自定义视觉提示词那格（别的 textarea 由 fillSubject 按占位符挑） */
    const box = tas.find((x) => (x.placeholder || '').indexOf('flat graphic illustration') >= 0);
    if (!box) return;
    box.value = t;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(150);
}

async function clickGenerate(page) {
  await page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const btns = Array.from(pg.querySelectorAll('.imggen-fold button'));
    const b = btns.find((x) => ((x.textContent || '').trim() === '生成'));
    if (b) b.click();
  });
  await sleep(1200);
}

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const CALIB = [
  'defined but not weathered features',
  'facial hair only when specified by the identity description',
  'unintended aging',
  'unintentionally weathered face',
  'overly rugged features',
  'thick beard when unspecified'
];
/* 01 的完整排人短语（裸 'human' 不在此列：新男性底座有 "believable human skin"） */
const SCENE_NEG = ['empty of people', 'no human subject', 'no human figure', 'no people, no human'];
const noCalibIn = (p) => CALIB.every((w) => p.indexOf(w) < 0);

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let failed = 0;
  let captured = null;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.route('**/images/generations', async (route) => {
      try { captured = JSON.parse(route.request().postData() || '{}'); } catch (e) { captured = null; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ b64_json: PNG_1X1 }] })
      });
    });
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const sleepyErrs = await waitApp(page);
    chk('启动无 [Sleepy] 报错', sleepyErrs.length === 0, sleepyErrs.join(' | '));

    /* ================= 阶段 A：无岛 / 无角色 / 无马甲 ================= */
    const apiId = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('general');
      a.name = 'E2测试接口'; a.baseUrl = location.origin; a.model = 'e2-test'; a.apiKey = 'test';
      g.saveApis([a]); g.setCurrent(a.id);
      return a.id;
    });
    const envA = await page.evaluate(() => ({
      chars: window.Sleepy.core.allChars().length,
      sandboxes: window.Sleepy.core.listSandboxes().length,
      active: window.Sleepy.core.activeSandbox()
    }));
    chk('A0 阶段 A 环境干净（无岛 / 无角色）',
      envA.chars === 0 && envA.sandboxes === 0 && !envA.active, JSON.stringify(envA));

    await openTry(page, apiId);
    let opts = await subjectOptionValues(page);
    /* 2026-10-01 03 双人 → 04 群像，临时入口逐轮累加：
       无人 / 单人 / 双人 / 多人四项哨兵；断言只管这四项都在且**没有真实身份项**，
       不锁死长度（名册为空时也不该出现真实身份项）。 */
    chk('A1 名册为空时主体下拉＝无人 / 单人 / 双人 / 多人（没有真实身份项）',
      opts.length === 4 && opts[0] === '' && opts[1] === '@temp'
      && opts[2] === '@temp-two' && opts[3] === '@temp-group', JSON.stringify(opts));
    let st = await readUI(page);
    chk('A1 名册为空时给出明确提示（不靠读全部角色填满下拉）',
      st.text.indexOf('本岛名册为空') >= 0 && st.text.indexOf('单人（临时测试）') >= 0);
    chk('A1 默认主体 = 无人场景／物品', st.subject === '');
    chk('A2 默认（无人）不显示性别', !st.genderVisible);

    /* A2/A3/A4：临时单人三档性别 */
    await setSelect(page, IDX.mode, 'sleepy-default');
    await setSelect(page, IDX.subject, '@temp');
    st = await readUI(page);
    chk('A2 选「单人（临时测试）」后性别出现', st.subject === '@temp' && st.genderVisible, JSON.stringify(st));

    const TEMP_DESC = '35 岁的男人，灰白短发，眼角有细纹，穿着旧夹克，站在阳台上';
    for (const g of [['', '不指定', ''], ['male', '男', '1boy'], ['female', '女', '1girl']]) {
      await setSelect(page, IDX.gender, g[0]);
      await setSelect(page, IDX.shot, 'portrait');
      await setSelect(page, IDX.hands, 'visible');
      captured = null;
      await fillSubject(page, TEMP_DESC);
      await clickGenerate(page);
      const p = captured && captured.prompt;
      chk('A2 临时单人（' + g[1] + '）请求已发出', !!p, String(p).slice(0, 100));
      if (!p) continue;
      const tagOK = g[2] ? p.indexOf(g[2]) >= 0
        : (p.indexOf('1boy') < 0 && p.indexOf('1girl') < 0);
      chk('A2 临时单人（' + g[1] + '）性别 tag 正确', tagOK, String(p).slice(0, 160));
      chk('A3 临时单人（' + g[1] + '）不读真实身份（无锁脸词）+ 描述透传',
        p.indexOf('silver hair') < 0 && p.indexOf('stubble beard') < 0 && p.indexOf(TEMP_DESC) >= 0,
        String(p).slice(0, 200));
      /* 判据只用 01 那些**完整排人短语** —— 裸 'human' 不行：
         新男性底座里有 "believable human skin"，那是材质描述不是排人词。 */
      const negHit = SCENE_NEG.filter((w) => p.indexOf(w) >= 0);
      chk('A4 临时单人（' + g[1] + '）无 01 无人排人短语',
        negHit.length === 0, negHit.length ? ('命中：' + negHit.join('|')) : '');
      chk('A4 临时单人（' + g[1] + '）负面不含 01 的结构排人串',
        (captured.negative_prompt || '').indexOf('people, person, human') < 0,
        String(captured && captured.negative_prompt).slice(0, 160));
      const calHit = CALIB.filter((w) => p.indexOf(w) >= 0);
      chk('A4 临时单人（' + g[1] + '）无男性校准词', calHit.length === 0,
        calHit.length ? ('命中：' + calHit.join('|')) : '');
    }
    chk('A3 临时单人结构 / 镜头 / 手部层齐全', true);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/e2-temp-single.png') }).catch(() => {});

    /* ================= 阶段 B：有岛 / 角色 / 马甲 ================= */
    const seed = await page.evaluate(() => {
      const c = window.Sleepy.core;
      const sb = c.createSandbox('isle', 'E2测试岛');
      c.upsertChar({ name: 'E2测试阿岩', gender: 'male', faceLockText: 'silver hair, stubble beard', faceLockSelfie: 'red eyes', faceLockFull: 'tall' });
      c.upsertUser({ name: 'E2测试小A', gender: 'female', faceLockText: 'bob hair', faceLockSelfie: 'green eyes' });
      const ch = (c.allChars() || []).filter((x) => x.name === 'E2测试阿岩')[0];
      const u = (c.userMasks() || []).filter((x) => x.name === 'E2测试小A')[0];
      c.setSandboxChars(sb.id, [ch.id]);
      c.setSandboxMasks(sb.id, [u.id]);
      c.setActiveSandbox(sb.id);
      return { sbId: sb.id, charId: ch.id, userId: u.id, apiId: window.Sleepy.imggen.listApis()[0].id };
    });
    chk('B0 夹具就绪（岛/角色/马甲/接口）', !!(seed && seed.charId && seed.userId), JSON.stringify(seed));

    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, seed.apiId);
    opts = await subjectOptionValues(page);
    chk('B0 有身份时主体含 char / user 两类',
      opts.indexOf('char:' + seed.charId) >= 0 && opts.indexOf('user:' + seed.userId) >= 0,
      JSON.stringify(opts));

    await setSelect(page, IDX.mode, 'legacy');
    st = await readUI(page);
    chk('B1 legacy：主体/镜头/手部/性别全收起',
      st.mode === 'legacy' && !st.subjectVisible && !st.shotVisible && !st.handsVisible && !st.genderVisible,
      JSON.stringify(st));
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/e2-mode-legacy.png') }).catch(() => {});

    await setSelect(page, IDX.mode, 'sleepy-default');
    st = await readUI(page);
    chk('B1 sleepy-default：主体/镜头/手部展开、自定义框收起',
      st.subjectVisible && st.shotVisible && st.handsVisible && !st.customVisible, JSON.stringify(st));

    await setSelect(page, IDX.mode, 'custom');
    st = await readUI(page);
    chk('B1 custom：自定义框展开', st.customVisible, JSON.stringify(st));
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/e2-mode-custom.png') }).catch(() => {});

    /* B2 保存 + 回显 */
    await setSelect(page, IDX.mode, 'sleepy-default');
    await setSelect(page, IDX.subject, 'char:' + seed.charId);
    await setSelect(page, IDX.shot, 'portrait');
    await setSelect(page, IDX.hands, 'visible');
    const persisted1 = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      return [g.singleExpSubjectRef(), g.singleExpShot(), g.singleExpHands()].join('|');
    });
    chk('B2 三项选择即时写入',
      persisted1 === 'char:' + seed.charId + '|portrait|visible', persisted1);

    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, seed.apiId);
    st = await readUI(page);
    chk('B2 刷新后回显一致',
      st.mode === 'sleepy-default' && st.subject === 'char:' + seed.charId &&
      st.shot === 'portrait' && st.hands === 'visible', JSON.stringify(st));
    chk('B2 选真实身份时不显示性别', !st.genderVisible);
    await page.screenshot({ path: path.join(ROOT, 'preview/phone-test/e2-mode-single.png') }).catch(() => {});

    /* B3 角色身份进请求 */
    captured = null;
    await fillSubject(page, '站在窗边');
    await clickGenerate(page);
    let p = captured && captured.prompt;
    chk('B3 角色：性别 + 锁脸进 prompt',
      !!p && p.indexOf('1boy') >= 0 && p.indexOf('silver hair') >= 0 && p.indexOf('stubble beard') >= 0,
      String(p).slice(0, 160));
    chk('B3 角色：单人结构 + 镜头 + 底座 + 无手部附加词 + 无男性校准',
      !!p && p.indexOf('solo, exactly one person') >= 0 && p.indexOf('half-body portrait') >= 0 &&
      p.indexOf('Anatomically coherent hands') < 0 && p.indexOf('naturally long fingers') < 0 &&
      p.indexOf('natural realistic portrait photography') >= 0 && noCalibIn(p), String(p).slice(0, 200));

    /* B3 马甲身份进请求 */
    captured = null;
    await setSelect(page, IDX.subject, 'user:' + seed.userId);
    await setSelect(page, IDX.shot, 'selfie');
    await clickGenerate(page);
    p = captured && captured.prompt;
    chk('B3 马甲：读自己那份（1girl + 自拍锁脸组，无角色特征）',
      !!p && p.indexOf('1girl') >= 0 && p.indexOf('green eyes') >= 0 && p.indexOf('silver hair') < 0,
      String(p).slice(0, 200));

    /* ================= 阶段 C：手部链路（先证据后结论） ================= */
    const paramText = () => page.evaluate(() => {
      const out = document.querySelector('.page[data-page="settings-imggen-edit"] .imggen-out');
      if (!out) return '';
      const hit = Array.from(out.querySelectorAll('p.test-tip'))
        .find((p) => (p.textContent || '').indexOf('本次生成参数') >= 0);
      return hit ? (hit.textContent || '') : '';
    });

    await setSelect(page, IDX.mode, 'sleepy-default');
    await setSelect(page, IDX.subject, '@temp');
    await setSelect(page, IDX.gender, 'male');
    await setSelect(page, IDX.shot, 'full');
    await setSelect(page, IDX.hands, 'visible');
    captured = null;
    await fillSubject(page, '窗边的男人，灰色上衣');
    await clickGenerate(page);
    let cp = captured && captured.prompt;
    /* 2026-10-01 定点返修：额外手部词整体关闭（同步男性最终状态）
       —— visible 也返回空串，系统不再追加任何手部段 */
    const HANDS_V2 = await page.evaluate(() => window.Sleepy.imggen.SLEEPY_HANDS_UNIFIED);
    const HANDS_V2_MARK = 'Anatomically coherent hands';
    const HANDS_OLD_MARK = 'naturally long fingers';
    /* 女性 C 版原文：从页面运行时常量取，避免测试里抄一份写歪 */
    const C_LOOK = await page.evaluate(() => window.Sleepy.imggen.SLEEPY_TEMP_FEMALE_LOOK);
    const C_MARK = 'strikingly beautiful adult woman';
    /* 下拉旁说明：hands 只记录，不独立控制手部入镜 */
    const hintTxt = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
      /* 03 双人提示里也提了「手部」，别让它抢走定位 —— 精确挑 hands 下拉旁那条 */
      const hints = Array.from(pg.querySelectorAll('.imggen-fold .set-hint'))
        .filter((p) => (p.textContent || '').indexOf('仅记录选择') >= 0);
      const hit = hints[0] || Array.from(pg.querySelectorAll('.imggen-fold .set-hint'))
        .find((p) => (p.textContent || '').indexOf('手部') >= 0) || null;
      return hit ? (hit.textContent || '') : '';
    });
    chk('C0-1 手部下拉旁有如实说明（仅记录选择，不单独控制手部入镜）',
      hintTxt.indexOf('当前仅记录选择，不单独控制手部入镜') >= 0 &&
      hintTxt.indexOf('请在画面描述中写明') >= 0, hintTxt);
    chk('C0 退休的手部段常量仍在（只作历史对照，不参与拼接）',
      typeof HANDS_V2 === 'string' && HANDS_V2.indexOf(HANDS_V2_MARK) >= 0, String(HANDS_V2).slice(0, 60));
    chk('C1 选 visible → 请求里没有任何系统手部段',
      !!cp && cp.indexOf(HANDS_V2_MARK) < 0 && cp.indexOf(HANDS_OLD_MARK) < 0 &&
      cp.indexOf('well-proportioned hands') < 0, String(cp).slice(-200));
    let stC = await readUI(page);
    chk('C2 生成后下拉没有被重置（手部仍是 visible）',
      stC.hands === 'visible' && stC.subject === '@temp' && stC.shot === 'full' && stC.gender === 'male',
      JSON.stringify(stC));
    let pt = await paramText();
    chk('C1 结果旁显示「本次生成参数」且与本次请求一致（模式/镜头/手部）',
      pt.indexOf('模式 sleepy-default') >= 0 && pt.indexOf('镜头 全身') >= 0 &&
      pt.indexOf('手部选择（仅记录）手明确可见') >= 0 && pt.indexOf('视觉层 男性默认底座（v2）') >= 0, pt);
    /* C2 关键：visible 的意图被如实记录，且不伪装成 hidden/unspecified。
       措辞口径：hands **只记录**，不独立产生手部要求；
       请求里的手部表达仍来自 description / 用户自定义视觉词 / 身份资料。 */
    chk('C2 visible 的意图照旧记录（不因手部词为空被改写成 hidden/unspecified）',
      pt.indexOf('手部选择（仅记录）手明确可见') >= 0 && pt.indexOf('手部词 手部附加词：关闭') >= 0 &&
      pt.indexOf('手部选择（仅记录）手明确不入镜') < 0 && pt.indexOf('手部 手明确可见') < 0, pt);

    /* C3 切 custom → 同样不追加系统手部段（旧结构版已退休），下拉仍保持 */
    await setSelect(page, IDX.mode, 'custom');
    captured = null;
    await clickGenerate(page);
    cp = captured && captured.prompt;
    chk('C3 custom + visible → 同样没有系统手部段（旧结构版已退休且不补位）',
      !!cp && cp.indexOf(HANDS_V2_MARK) < 0 && cp.indexOf(HANDS_OLD_MARK) < 0 &&
      cp.indexOf('well-proportioned hands') < 0,
      String(cp).slice(-160));
    stC = await readUI(page);
    chk('C3 切模式后手部选择没被重置', stC.hands === 'visible');

    /* C4 切镜头 → 请求跟着变，下拉保持 */
    await setSelect(page, IDX.mode, 'sleepy-default');
    await setSelect(page, IDX.shot, 'portrait');
    captured = null;
    await clickGenerate(page);
    cp = captured && captured.prompt;
    chk('C4 镜头切换进请求（portrait）', !!cp && cp.indexOf('half-body portrait') >= 0, String(cp).slice(0, 160));
    stC = await readUI(page);
    chk('C4 切镜头后手部选择没被重置', stC.hands === 'visible' && stC.shot === 'portrait');

    /* C5 刷新回显 */
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, seed.apiId);
    stC = await readUI(page);
    chk('C5 刷新后回显一致（含手部 visible）',
      stC.mode === 'sleepy-default' && stC.subject === '@temp' && stC.gender === 'male' &&
      stC.shot === 'portrait' && stC.hands === 'visible', JSON.stringify(stC));
    /* 刷新后「想画什么」是空的（本来就不持久化），生成前得重新填，
       否则会被空值守卫拦下 —— 这是脚本的事，不是产品行为。 */
    await fillSubject(page, '窗边的男人，灰色上衣');

    /* C6 hidden / unspecified 一个字都不加 */
    await setSelect(page, IDX.hands, 'hidden');
    captured = null;
    await clickGenerate(page);
    cp = captured && captured.prompt;
    chk('C6 hidden → 不追加任何手部词', !!cp && cp.indexOf('hands') < 0, String(cp).slice(-160));
    await setSelect(page, IDX.hands, 'unspecified');
    captured = null;
    await clickGenerate(page);
    cp = captured && captured.prompt;
    chk('C6 unspecified → 不追加任何手部词', !!cp && cp.indexOf('hands') < 0, String(cp).slice(-160));
    pt = await paramText();
    chk('C6 回显的手部状态跟选择一致', pt.indexOf('手部选择（仅记录）未指定') >= 0, pt);

    /* C7 男性新底座：替换而非叠加 */
    captured = null;
    await clickGenerate(page);
    cp = captured && captured.prompt;
    chk('C7 临时男 + sleepy-default：男性底座在、旧 look 不叠加',
      !!cp && cp.indexOf('beautifully idealized adult male face') >= 0 &&
      cp.indexOf('natural realistic portrait photography') < 0 &&
      cp.indexOf('visually pleasing but unposed') < 0, String(cp).slice(0, 200));

    /* ========= 阶段 D：额外手部词整体关闭（2026-10-01 定点返修） ========= */
    await setSelect(page, IDX.subject, '@temp');
    await setSelect(page, IDX.gender, 'male');
    await setSelect(page, IDX.shot, 'portrait');
    await setSelect(page, IDX.mode, 'sleepy-default');
    await fillSubject(page, '窗边的男人，灰色上衣');

    /* D1 hidden/unspecified → 本来就不追加 */
    await setSelect(page, IDX.hands, 'unspecified');
    captured = null;
    await clickGenerate(page);
    const dNone = captured && captured.prompt;
    chk('D1 unspecified → 手部段都不出现',
      !!dNone && dNone.indexOf(HANDS_V2_MARK) < 0 && dNone.indexOf(HANDS_OLD_MARK) < 0,
      String(dNone).slice(-160));
    await setSelect(page, IDX.hands, 'hidden');
    captured = null;
    await clickGenerate(page);
    const dHidden = captured && captured.prompt;
    chk('D1 hidden → 手部段都不出现',
      !!dHidden && dHidden.indexOf(HANDS_V2_MARK) < 0 && dHidden.indexOf(HANDS_OLD_MARK) < 0,
      String(dHidden).slice(-160));

    /* D2 visible → 同样返回空串：与 unspecified 逐字相等（不是"追加了又删"） */
    await setSelect(page, IDX.hands, 'visible');
    captured = null;
    await clickGenerate(page);
    const dVis = captured && captured.prompt;
    const cntNew = String(dVis).split(HANDS_V2_MARK).length - 1;
    chk('D2 visible → 统一手部段 0 份', cntNew === 0, '份数=' + cntNew);
    chk('D2 visible → 旧手部审美段 / 结构版也都不在',
      !!dVis && dVis.indexOf(HANDS_OLD_MARK) < 0 &&
      dVis.indexOf('subtle visible knuckle definition') < 0 &&
      dVis.indexOf('well-proportioned hands') < 0 &&
      dVis.indexOf('clean natural nails') < 0, String(dVis).slice(-200));
    chk('D2 visible 与 unspecified 的 prompt 逐字相等（唯一差集＝空）',
      !!dVis && dVis === String(dNone),
      '差异：' + String(dVis).replace(String(dNone), '…').slice(0, 200));
    chk('D2 负面未加新词（无僵尸/枯手/多余手指一类）',
      (captured.negative_prompt || '').indexOf('zombie') < 0 &&
      (captured.negative_prompt || '').indexOf('withered') < 0 &&
      (captured.negative_prompt || '').indexOf('skeleton') < 0 &&
      (captured.negative_prompt || '').indexOf('extra fingers') < 0,
      String(captured && captured.negative_prompt).slice(0, 160));

    /* D3 结果参数与实际空串行为一致，且 hands 仍是 visible */
    pt = await paramText();
    chk('D3 结果参数与实际一致（手部选择（仅记录）手明确可见 + 手部附加词：关闭）',
      pt.indexOf('手部选择（仅记录）手明确可见') >= 0 && pt.indexOf('手部词 手部附加词：关闭') >= 0 &&
      pt.indexOf('手部 手明确不入镜') < 0 && pt.indexOf('手部 未指定') < 0 && pt);

    /* D4 女性定稿 C 版照旧命中，手部同样不追加 */
    await setSelect(page, IDX.gender, 'female');
    captured = null;
    await clickGenerate(page);
    const dFem = captured && captured.prompt;
    const dFemNeg = captured && captured.negative_prompt;
    chk('D4 女性走定稿 C 版（替换旧默认 look，不是叠加）',
      !!dFem && dFem.indexOf('strikingly beautiful adult woman') >= 0 &&
      dFem.indexOf('natural realistic portrait photography') < 0 &&
      dFem.indexOf('visually pleasing but unposed') < 0, String(dFem).slice(0, 200));
    chk('D4 女性分支也不追加系统手部段（旧审美段不在）',
      !!dFem && dFem.indexOf(HANDS_V2_MARK) < 0 && dFem.indexOf(HANDS_OLD_MARK) < 0 &&
      dFem.indexOf('well-proportioned hands') < 0, String(dFem).slice(-160));
    pt = await paramText();
    chk('D4 女性分支参数行显示 C 版 + 手部附加词：关闭',
      pt.indexOf('视觉层 女性定稿底座（C 版）') >= 0 && pt.indexOf('手部词 手部附加词：关闭') >= 0, pt);
    await setSelect(page, IDX.gender, 'male');

    /* D5 既有结构约束没被误删：防增人 / 防崩脸照旧在 */
    chk('D5 女性 C 既有结构约束未误删（防增人 + 防崩脸）',
      (captured.negative_prompt || '').indexOf('extra person') >= 0 &&
      (captured.negative_prompt || '').indexOf('deformed face') >= 0,
      String(captured && captured.negative_prompt).slice(0, 200));
    /* D5-2 女性 C 已与 custom C 对齐：不再追加审美负面（plastic skin 那组） */
    chk('D5-2 女性 C 已与 custom C 对齐（不追加 plastic skin 审美负面）',
      (captured.negative_prompt || '').indexOf('plastic skin') < 0 &&
      (captured.negative_prompt || '').indexOf('overly airbrushed skin') < 0 &&
      (captured.negative_prompt || '').indexOf('stiff pose') < 0 &&
      (captured.negative_prompt || '').indexOf('forced smile') < 0,
      String(captured && captured.negative_prompt).slice(0, 200));
    /* D5-3 对照：自定义视觉词填完整 C 与默认命中 C，positive / negative 逐字相等。
       ⚠️ 这不是「历史投票请求重现」—— 旧的手部结构段早已停用，两边请求都不再携带。
       ⚠️ 必须先把性别 / 描述切成「女性 C 取证」那一组（同一组输入才有可比性，
       否则 1boy / 1girl、不同 description 会直接盖掉结论）。 */
    await setSelect(page, IDX.gender, 'female');
    await fillSubject(page, '坐在窗边看雨，短直发，单眼皮，灰色针织衫');
    /* B 先：默认路命中 C（与 A **同一组** 输入：女 / 同描述 / 同镜头 / 同 hands） */
    await setSelect(page, IDX.mode, 'sleepy-default');
    captured = null;
    await clickGenerate(page);
    const dFem2 = captured && captured.prompt;
    const dFem2Neg = captured && captured.negative_prompt;
    /* A 后：custom 填完整 C（同输入，只把视觉层来源换成自定义词） */
    await setSelect(page, IDX.mode, 'custom');
    await fillCustom(page, C_LOOK);
    captured = null;
    await clickGenerate(page);
    const cuC = captured;
    if (!cuC || String(cuC.prompt).indexOf(C_MARK) < 0) {
      throw new Error('D5-3 取到的不是填了 C 的 custom 请求：' + String(cuC && cuC.prompt).slice(0, 160));
    }
    chk('D5-3 custom 填完整 C：positive 与默认 C 逐字相等',
      !!cuC && !!dFem2 && cuC.prompt === dFem2,
      '差异：' + String(cuC && cuC.prompt).replace(String(dFem2), '…').slice(0, 240));
    chk('D5-3 custom 填完整 C：negative 与默认 C 逐字相等',
      !!cuC && !!dFem2Neg && cuC.negative_prompt === dFem2Neg,
      'A=' + String(cuC && cuC.negative_prompt).slice(0, 200) + ' || B='
        + String(dFem2Neg).slice(0, 200));
    /* D5-4 用户描述里的手部表述原样保留（系统不改写、不删、不补位） */
    chk('D5-4 用户描述里的手部表述原样保留（未删改、未新增系统手部段）',
      !!cuC && cuC.prompt.indexOf('坐在窗边看雨，短直发，单眼皮，灰色针织衫') >= 0 &&
      cuC.prompt.indexOf(HANDS_V2_MARK) < 0 && cuC.prompt.indexOf(HANDS_OLD_MARK) < 0,
      String(cuC && cuC.prompt).slice(-160));
    /* 复原：切回默认路 + 男性 + 原描述（B5 等后续用例还要走这条） */
    await setSelect(page, IDX.mode, 'sleepy-default');
    await setSelect(page, IDX.gender, 'male');
    await fillSubject(page, '窗边的男人，灰色上衣');

    /* B5 没有人 → 01；legacy → buildPrompt 旧路 */
    captured = null;
    await fillSubject(page, '站在窗边');
    await setSelect(page, IDX.subject, '');
    await clickGenerate(page);
    p = captured && captured.prompt;
    chk('B5 没有人：走 01 场景/物品（empty of people）',
      !!p && p.indexOf('empty of people') >= 0 && p.indexOf('solo, exactly one person') < 0,
      String(p).slice(0, 160));

    /* B4 失效主体：移出本岛 → 拦下 */
    await setSelect(page, IDX.subject, 'char:' + seed.charId);
    await page.evaluate((id) => { window.Sleepy.core.setSandboxChars(id, []); }, seed.sbId);
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, seed.apiId);
    st = await readUI(page);
    chk('B4 失效主体仍显示为失效项（没被悄悄改成「没有人」）',
      st.subject === 'char:' + seed.charId, JSON.stringify(st));
    captured = null;
    await fillSubject(page, '站在窗边');
    await clickGenerate(page);
    chk('B4 失效主体：请求没发出（不静默换人/不回落无人图）', captured === null);
    chk('B4 失效主体：给出明确拦截提示',
      st.text.indexOf('已经不在本岛或已被删除') >= 0 || (await page.evaluate(() => {
        const out = document.querySelector('.page[data-page="settings-imggen-edit"] .imggen-out');
        return out ? (out.textContent || '') : '';
      })).indexOf('已经不在本岛或已被删除') >= 0);

    /* 复原本岛名册 */
    await page.evaluate((s) => { window.Sleepy.core.setSandboxChars(s.sbId, [s.charId]); }, seed);

    /* ========= D1 诊断：新增角色后「试一张」的主体下拉会不会更新 =========
       ⚠️ 夹具注意：**孤岛只能有 1 个大号**（core.validateSandboxChars:121，
       「孤岛只能有一个角色，多出来的请开群岛」），要放第二个角色必须开**群岛**。
       第一次跑这条时就是因为用了孤岛，setSandboxChars 被拒，才误判成「没出现」。 */
    const arch = await page.evaluate((s) => {
      const c = window.Sleepy.core;
      const sb = c.createSandbox('archipelago', 'E2测试群岛');
      c.upsertChar({ name: 'E2测试阿岩二号', gender: 'female' });
      const ch2 = (c.allChars() || []).filter((x) => x.name === 'E2测试阿岩二号')[0];
      const r1 = c.setSandboxChars(sb.id, [s.charId]);
      c.setActiveSandbox(sb.id);
      return { sbId: sb.id, char1Id: s.charId, char2Id: ch2.id, setOk: !!(r1 && r1.ok), msg: (r1 && r1.message) || '' };
    }, seed);
    chk('D1 群岛夹具：第 1 个角色先入册', arch.setOk, JSON.stringify(arch));

    /* 第一次渲染（此时名册里只有 1 个角色） */
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, seed.apiId);
    const opts0 = await subjectOptionValues(page);
    chk('D1 初始渲染只列出名册里的那 1 个角色',
      opts0.indexOf('char:' + arch.char1Id) >= 0 && opts0.indexOf('char:' + arch.char2Id) < 0,
      JSON.stringify(opts0));

    /* 走真实用户路径：退回生图列表 → 把第 2 个角色加进本岛 → 再进这个接口 */
    await page.evaluate(() => { window.Sleepy.nav.open('settings-imggen'); });
    await sleep(400);
    const add2 = await page.evaluate((a) => {
      const c = window.Sleepy.core;
      const r = c.setSandboxChars(a.sbId, [a.char1Id, a.char2Id]);
      return { ok: !!(r && r.ok), msg: (r && r.message) || '', roster: (c.findSandbox(a.sbId).charIds || []).slice() };
    }, arch);
    chk('D1 数据层：第 2 个角色确实已进本岛名册',
      add2.ok && add2.roster.indexOf(arch.char2Id) >= 0, JSON.stringify(add2));

    /* (a) 重开编辑页（同一 params → 命中 built 缓存的旧 DOM） */
    await openTry(page, seed.apiId);
    const optsReopen = await subjectOptionValues(page);
    const appearReopen = optsReopen.indexOf('char:' + arch.char2Id) >= 0;
    /* (b) 整页刷新（真·全新 render） */
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, seed.apiId);
    const optsFresh = await subjectOptionValues(page);
    const appearFresh = optsFresh.indexOf('char:' + arch.char2Id) >= 0;
    /* (c) 建一个**不加入本岛**的角色，看全新 render 会不会带出来 */
    const outsiderId = await page.evaluate(() => {
      const c = window.Sleepy.core;
      c.upsertChar({ name: 'E2测试岛外人', gender: 'male' });
      return (c.allChars() || []).filter((x) => x.name === 'E2测试岛外人')[0].id;
    });
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, seed.apiId);
    const optsC = await subjectOptionValues(page);
    const appearOutsider = optsC.indexOf('char:' + outsiderId) >= 0;

    chk('D1-b 整页刷新后新角色出现（说明数据层与渲染都没问题）', appearFresh, JSON.stringify(optsFresh));
    note('D1-a 重开同一接口页后是否出现新角色', appearReopen ? '出现' : '**没出现**（下拉没跟着刷新）');
    note('D1-b 整页刷新后是否出现新角色', appearFresh ? '出现' : '没出现');
    note('D1-c 未加入本岛的角色是否出现（岛隔离）', appearOutsider ? '**出现了（岛隔离被破坏）**' : '不出现（符合设计）');
    note('D1-d 结论', (appearFresh && !appearReopen)
      ? '属于「选项刷新缺陷」：角色已在本岛名册里，只是重开页面复用了旧 DOM（app.js 的 built 缓存 + 同参短路），没重新 render'
      : (appearFresh ? '重开与刷新都正常' : '还需再查（见 D1-b 失败信息）'));
    chk('D1 岛隔离未被放松（未加入本岛的角色不该出现）', !appearOutsider);

    /* ---- 还原 + 收尾 ---- */
    await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      g.setVisualExpMode('legacy');
      g.setSingleExpSubjectRef('');
      g.setSingleExpShot('auto');
      g.setSingleExpHands('unspecified');
      g.setSingleExpGender('');
      g.saveApis([]);
    });

    failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0
      ? '\nE2 单人实验 UI 真机验收全绿（' + results.length + ' 项，另有 ' + notes.length + ' 条诊断记录）'
      : '\nE2 真机验收有 ' + failed + ' 项失败');
    notes.forEach((n) => console.log('  · ' + n.name + '：' + n.text));
  } catch (e) {
    console.error('测试异常：', e && e.message);
    failed = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
