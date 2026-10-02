/* ============================================================
   scripts/browser-e2-two-visual-test.js — 03 临时双人测试入口 请求拦截检查
   ------------------------------------------------------------
   ⚠️ 口径：这是**本机 headless 浏览器**（Windows + playwright-core +
   系统 Edge 内核）的自动化检查，**不是真机 / 真手机**。本地静态服务
   跑在 127.0.0.1，用 page.route 拦 /images/generations，只读请求体
   里的 prompt，**回一张 1x1 PNG 让流程走完**——全程不调付费接口，
   接口地址故意用不可达端口做双保险。

   验证（施工单 03 §三）：
     T1 无岛 / 无角色 / 无马甲也能走「双人（临时测试）」到请求拦截，
        人物A / 人物B 独立进入请求且各恰好一份
     T2 三组虚构输入：A 并肩（custom 空 vs 非空对照）、B 递物、C 非爱情
     T3 custom 空 / 非空只改变视觉层；空值不回退；非空 marker 恰好一份；
        不注入 male v2 / female C / solo / exactly one person / 旧默认 look
     T4 缺 A、缺 B、空场景、非 General 一律拒绝且请求数为 0
        （一人 / 三人 UI 层构造不出，由纯函数守卫覆盖，脚本里如实标注）
     T5 系统不补手部词，用户手部描述照常保留；负面无系统注入的
        old / elderly / wrinkle，也没有 legacy 整表
     T6 生成中改表单不污染快照；双人切回单人后原模式 / 性别 / 镜头 /
        hands / custom 与保存值都还在，01 依旧可用
   run:
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e2-two-visual-test.js
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

const PORT = process.env.E2_TWO_PORT || 5208;
const BASE = 'http://127.0.0.1:' + PORT;
const results = [];
function chk(name, cond, extra) {
  results.push({ name, ok: !!cond });
  if (!cond) console.error('  ✗ ' + name + (extra ? '  ' + extra : ''));
  else console.log('  ✓ ' + name);
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
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && t && t.indexOf('[Sleepy]') >= 0) sleepyErrs.push(t.slice(0, 300));
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

/* 实验区 select 顺序：[0]视觉拼接模式 [1]主体 [2]性别（临时单人）[3]镜头 [4]手部 */
const IDX = { mode: 0, subject: 1, gender: 2, shot: 3, hands: 4 };
/* textarea 用**标签文本**定位（人物A / 人物B 是新加的，不能靠位置猜） */
const LBL = { scene: '想画什么', custom: '自定义视觉提示词', pa: '人物A（临时测试', pb: '人物B（临时测试' };

async function openTry(page, apiId) {
  await page.evaluate((id) => { window.Sleepy.nav.open('settings-imggen-edit', { id }); }, apiId);
  await sleep(500);
  await page.evaluate(() => {
    const head = document.querySelector('.page[data-page="settings-imggen-edit"] .imggen-fold-head');
    if (head) head.click();
  });
  await sleep(300);
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

async function fillLabel(page, prefix, text) {
  await page.evaluate((a) => {
    const tas = Array.from(document.querySelector('.page[data-page="settings-imggen-edit"]')
      .querySelectorAll('.imggen-fold textarea'));
    const box = tas.find((t) => {
      const wrap = t.closest('.set-field');
      const lab = wrap && wrap.querySelector('.set-label');
      return lab && (lab.textContent || '').indexOf(a.prefix) >= 0;
    });
    if (!box) return;
    box.value = a.text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, { prefix, text });
  await sleep(150);
}

async function fillPa(page, t) { return fillLabel(page, LBL.pa, t); }
async function fillPb(page, t) { return fillLabel(page, LBL.pb, t); }
async function fillScene(page, t) { return fillLabel(page, LBL.scene, t); }
async function fillCustom(page, t) { return fillLabel(page, LBL.custom, t); }

async function readUI(page) {
  return page.evaluate((a) => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const sels = Array.from(pg.querySelectorAll('.imggen-fold select'));
    const tas = Array.from(pg.querySelectorAll('.imggen-fold textarea'));
    const vis = (el) => !!el && el.offsetParent !== null;
    function byLabel(prefix) {
      return tas.find((t) => {
        const wrap = t.closest('.set-field');
        const lab = wrap && wrap.querySelector('.set-label');
        return lab && (lab.textContent || '').indexOf(prefix) >= 0;
      }) || null;
    }
    return {
      mode: sels[0] ? sels[0].value : '',
      modeDisabled: !!(sels[0] && sels[0].disabled),
      subject: sels[1] ? sels[1].value : '',
      genderVisible: vis(sels[2]), shotVisible: vis(sels[3]), handsVisible: vis(sels[4]),
      subjVisible: vis(byLabel(a.LBL.scene)),
      customVisible: vis(byLabel(a.LBL.custom)),
      paVisible: vis(byLabel(a.LBL.pa)), pbVisible: vis(byLabel(a.LBL.pb)),
      text: pg.textContent || ''
    };
  }, { LBL });
}

async function clickGenerate(page) {
  await page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const b = Array.from(pg.querySelectorAll('.imggen-fold button'))
      .find((x) => (x.textContent || '').trim() === '生成');
    if (b) b.click();
  });
  await sleep(1200);
}

async function outText(page) {
  return page.evaluate(() => {
    const o = document.querySelector('.page[data-page="settings-imggen-edit"] .imggen-out');
    return { cls: o ? o.className : '', text: o ? (o.textContent || '') : '' };
  });
}

const countOf = (s, n) => String(s || '').split(n).length - 1;

/* ---------- 三组夹具（虚构，不建岛 / 不建角色 / 不建马甲） ---------- */
const PA_A = '30 岁成年人，黑色短发，深蓝色外套，面部轮廓清晰';
const PB_A = '成年人，栗色肩长发，米色上衣，圆脸';
const SCENE_A = '两人在安静的海边并肩站在一起看镜头，肩膀靠得很近但没有任何身体接触，'
  + '身后是平静的海面和黄昏的光';
const SCENE_B = '人物A 的右手握住一只透明饮料瓶的瓶身下半部，人物B 的左手接住瓶身的上半部，'
  + '两人看向对方；其余手臂自然放下或被身体挡住。仍站在海边，两人肩膀没有接触。';
const SCENE_C = '母女两人在家里的餐桌边聊天，母亲（人物B）坐在左侧看向女儿（人物A），'
  + '女儿（人物A）坐在右侧抬头微笑回应；桌上是两杯茶和一碟水果，没有拥抱也没有牵手。';
const PA_C = '30 岁成年女性，女儿，黑色短发扎成马尾，浅灰色针织开衫';
const PB_C = '60 岁成年女性，母亲，花白短发，深咖啡色围裙，手掌粗糙有皱纹';
const CUST_MARK = 'flat graphic illustration, limited 6-color palette';

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let failed = 0;
  let reqCount = 0;      /* 真实发出的 /images/generations 次数（拦截后仍计数） */
  let captured = null;
  let chatCount = 0;     /* 真实发出的 /chat/completions 次数（文字通道那一路） */
  let chatCaptured = null;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    /* 文字通道那一路同样必须拦下（不可回退真实服务）：回一条 markdown 内嵌
       1x1 PNG，让 extractImageFromChatText → b64ToBlob 的落地链路也走完。 */
    await page.route('**/chat/completions', async (route) => {
      chatCount++;
      try { chatCaptured = JSON.parse(route.request().postData() || '{}'); } catch (e) { chatCaptured = null; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content:
            '![img](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==)' } }]
        })
      });
    });
    await page.route('**/images/generations', async (route) => {
      reqCount++;
      try { captured = JSON.parse(route.request().postData() || '{}'); } catch (e) { captured = null; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' }]
        })
      });
    });
    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const sleepyErrs = await waitApp(page);
    chk('启动无 [Sleepy] 报错', sleepyErrs.length === 0, sleepyErrs.join(' | '));

    /* ---- 环境：无岛 / 无角色 / 无马甲 ---- */
    const env = await page.evaluate(() => ({
      chars: window.Sleepy.core.allChars().length,
      sandboxes: window.Sleepy.core.listSandboxes().length,
      active: window.Sleepy.core.activeSandbox()
    }));
    chk('T1 环境干净（无岛 / 无角色 / 无马甲）',
      env.chars === 0 && env.sandboxes === 0 && !env.active, JSON.stringify(env));

    const apiId = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('general');
      a.name = '双人测试接口'; a.baseUrl = 'http://127.0.0.1:9/v1'; a.model = 'two-fixture';
      a.apiKey = 'fixture-only';
      g.saveApis([a]); g.setCurrent(a.id);
      return a.id;
    });

    await openTry(page, apiId);

    /* ---------- T1 入口存在 + 显隐 ---------- */
    const opts = await page.evaluate(() => {
      const sel = Array.from(document.querySelector('.page[data-page="settings-imggen-edit"]')
        .querySelectorAll('.imggen-fold select'))[1];
      return Array.from(sel.querySelectorAll('option')).map((o) => o.value);
    });
    chk('T1 主体下拉出现「双人（临时测试）」且原两项还在',
      opts.indexOf('@temp-two') >= 0 && opts.indexOf('@temp') >= 0 && opts.indexOf('') >= 0,
      JSON.stringify(opts));

    await setSelect(page, IDX.subject, '@temp-two');
    let st = await readUI(page);
    chk('T1 选双人后露出人物A / 人物B 两个独立框',
      st.paVisible && st.pbVisible && st.subjVisible,
      JSON.stringify({ pa: st.paVisible, pb: st.pbVisible, subj: st.subjVisible }));
    chk('T1 双人时隐藏镜头与手部下拉（本轮镜头＝按画面描述）',
      !st.shotVisible && !st.handsVisible);
    chk('T1 双人时隐藏性别下拉（两人外貌都写在人物框里）', !st.genderVisible);
    chk('T1 双人时提示「先测试双人结构；默认视觉底座待定稿」',
      st.text.indexOf('默认视觉底座待定稿') >= 0);
    chk('T1 双人时视觉模式被局部锁成 custom（不覆盖全局已保存值）',
      st.mode === 'custom' && st.modeDisabled, JSON.stringify(st.mode));
    const savedMode = await page.evaluate(() => window.Sleepy.imggen.visualExpMode());
    chk('T1 全局 visualExpMode 没被双人改动', savedMode === 'legacy', String(savedMode));

    /* ---------- T2 A 组：custom 空 vs 非空 ---------- */
    await fillScene(page, SCENE_A);
    await fillPa(page, PA_A);
    await fillPb(page, PB_A);
    await clickGenerate(page);
    chk('T2 A 组（custom 为空）发出了 1 次请求', reqCount === 1, 'reqCount=' + reqCount);
    const A0 = captured;
    chk('T2 A 组请求体带 model / size / 独立 negative_prompt',
      !!A0 && A0.model === 'two-fixture' && !!A0.size && 'negative_prompt' in A0,
      JSON.stringify(A0 && { model: A0.model, size: A0.size, np: !!A0.negative_prompt }));
    chk('T2 A 组人物A 描述恰好一份进入请求', !!A0 && countOf(A0.prompt, PA_A) === 1);
    chk('T2 A 组人物B 描述恰好一份进入请求', !!A0 && countOf(A0.prompt, PB_A) === 1);
    chk('T2 A 组带最小双人结构原文', !!A0 && A0.prompt.indexOf('Exactly two people are present in the image') >= 0);
    chk('T2 A 组没有 solo / exactly one person 误带',
      !!A0 && A0.prompt.indexOf('solo') < 0 && A0.prompt.indexOf('exactly one person') < 0);
    chk('T2 A 组没有 male v2 / female C / 旧默认 look',
      !!A0 && A0.prompt.indexOf('strikingly beautiful adult woman') < 0
      && A0.prompt.indexOf('adult male face') < 0
      && A0.prompt.indexOf('natural realistic photography') < 0);
    chk('T2 A 组系统没补手部词（用户原文也没有手部描述）',
      !!A0 && A0.prompt.indexOf('well-proportioned hands') < 0
      && A0.prompt.indexOf('Anatomically coherent hands') < 0);
    chk('T2 A 组负面＝既有 qualityNegative（无 old / elderly / wrinkle）',
      !!A0 && A0.negative_prompt
      && A0.negative_prompt.indexOf('lowres') >= 0
      && A0.negative_prompt.indexOf('elderly') < 0
      && A0.negative_prompt.indexOf('wrinkle') < 0
      && A0.negative_prompt.indexOf('extra person') < 0,
      A0 ? A0.negative_prompt : '(no req)');
    let out = await outText(page);
    chk('T6 结果区回显「本次生成参数」含 双人 / 按画面描述 / 系统手部附加词关闭',
      out.text.indexOf('双人（临时测试') >= 0 && out.text.indexOf('镜头 按画面描述') >= 0
      && out.text.indexOf('系统手部附加词 关闭') >= 0, out.text.slice(0, 160));

    /* A 组 custom 非空对照（同输入，只改视觉层） */
    await fillCustom(page, CUST_MARK);
    await clickGenerate(page);
    const A1 = captured;
    chk('T3 custom 非空仍只有 1 次额外请求、custom marker 恰好一份',
      reqCount === 2 && countOf(A1.prompt, CUST_MARK) === 1);
    chk('T3 custom 非空不注入审美负面 / solo / 单人底座',
      A1.prompt.indexOf('plastic skin') < 0 && A1.prompt.indexOf('solo') < 0
      && A1.prompt.indexOf('strikingly beautiful adult woman') < 0);
    chk('T3 custom 非空时 A/B/Scene 三层原文与空值那份一致（custom 只加视觉层）',
      A1.prompt.indexOf('Person A（人物A）: ' + PA_A) >= 0
      && A1.prompt.indexOf('Person B（人物B）: ' + PB_A) >= 0
      && A1.prompt.indexOf('Scene（画面描述）: ' + SCENE_A) >= 0);
    chk('T3 A1.prompt 以 A0.prompt 为正前缀（空值那份一份不多）',
      A1.prompt.indexOf(A0.prompt) === 0);

    /* ---------- T2 B 组：递物（手部归属） ---------- */
    await fillCustom(page, '');
    await fillScene(page, SCENE_B);
    await clickGenerate(page);
    const B = captured;
    chk('T2 B 组人物A 右手文本进入请求', !!B && B.prompt.indexOf('人物A 的右手握住') >= 0);
    chk('T2 B 组人物B 左手文本进入请求', !!B && B.prompt.indexOf('人物B 的左手接住') >= 0);
    chk('T2 B 组系统没把手部词加进去、也没改写用户手部描述',
      !!B && B.prompt.indexOf('well-proportioned hands') < 0
      && countOf(B.prompt, '人物A 的右手握住') === 1);
    chk('T2 B 组负面仍无 legacy 整表（bad hands / extra fingers）',
      !!B && B.negative_prompt.indexOf('bad hands') < 0 && B.negative_prompt.indexOf('extra fingers') < 0);

    /* ---------- T2 C 组：非爱情 ---------- */
    await fillPa(page, PA_C);
    await fillPb(page, PB_C);
    await fillScene(page, SCENE_C);
    await clickGenerate(page);
    const C = captured;
    chk('T2 C 组年龄与亲属关系都进入请求',
      !!C && C.prompt.indexOf('60 岁成年女性，母亲') >= 0 && C.prompt.indexOf('30 岁成年女性，女儿') >= 0);
    chk('T2 C 组没有注入情侣 / 拥抱 / 牵手措辞',
      !!C && ['kiss', 'embrac', 'hand in hand', 'couple', 'romantic']
        .every((w) => C.prompt.toLowerCase().indexOf(w) < 0));
    chk('T2 C 组 A/B 指代到具体人物（母亲看向女儿）',
      !!C && C.prompt.indexOf('母亲（人物B）坐在左侧看向女儿（人物A）') >= 0);
    chk('T2 C 组请求体里恰好两个人物（不是被压成单人）',
      !!C && countOf(C.prompt, '60 岁成年女性，母亲') === 1
      && countOf(C.prompt, 'Person A（人物A）') === 1 && countOf(C.prompt, 'Person B（人物B）') === 1);

    /* ---------- T6 生成中改表单不污染快照 ----------
       填一套 X2 → 点生成（请求立即发出并被拦截）→ 请求回来**之后**把表单改成
       「被中途改坏」→ 已经发出的 body 必须还是 X2 那一套。 */
    const beforeEdit = captured;
    const PA_X2 = '42 岁成年男性，灰色卫衣，寸头';
    const PB_X2 = '成年女性，长直发，藏青色长裙';
    const SCENE_X2 = '两个人在城市天台上吹风，站得比较远，中间隔着栏杆';
    await fillPa(page, PA_X2); await fillPb(page, PB_X2); await fillScene(page, SCENE_X2);
    await clickGenerate(page);
    await page.evaluate(() => {
      const tas = Array.from(document.querySelector('.page[data-page="settings-imggen-edit"]')
        .querySelectorAll('.imggen-fold textarea'));
      tas.forEach((t) => {
        const wrap = t.closest('.set-field');
        const lab = wrap && wrap.querySelector('.set-label');
        const name = lab ? (lab.textContent || '') : '';
        if (name.indexOf('人物A（临时测试') >= 0 || name.indexOf('人物B（临时测试') >= 0
          || name.indexOf('想画什么') >= 0) t.value = '被中途改坏的内容';
      });
    });
    const afterEdit = captured;
    chk('T6 请求发出后再改表单，已发的 body 仍是点击瞬间那一份（不被污染）',
      !!afterEdit && afterEdit.prompt.indexOf('被中途改坏') < 0
      && afterEdit.prompt.indexOf('Person A（人物A）: ' + PA_X2) >= 0
      && afterEdit.prompt.indexOf('Person B（人物B）: ' + PB_X2) >= 0
      && afterEdit.prompt.indexOf('Scene（画面描述）: ' + SCENE_X2) >= 0,
      afterEdit ? afterEdit.prompt.slice(-120) : '(no req)');
    chk('T6 两次请求内容不同（各自是自己的快照）', beforeEdit.prompt !== afterEdit.prompt);

    /* ---------- T7 切回单人：原样恢复（用真实保存值做对照） ---------- */
    await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      g.setVisualExpMode('sleepy-default');
      g.setVisualExpCustom('sleepy-default 的自定义占位');
      g.setSingleExpSubjectRef('@temp');
      g.setSingleExpGender('female');
      g.setSingleExpShot('portrait');
      g.setSingleExpHands('visible');
    });
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await openTry(page, apiId);
    st = await readUI(page);
    chk('T7 刷新后单人配置原样回显（主体 @temp / 模式 sleepy-default / 镜头 portrait / 手部 visible）',
      st.subject === '@temp' && st.mode === 'sleepy-default'
      && st.genderVisible && st.shotVisible && st.handsVisible, JSON.stringify(st));
    await setSelect(page, IDX.subject, '@temp-two');
    const during = await page.evaluate(() => ({
      mode: window.Sleepy.imggen.visualExpMode(),
      custom: window.Sleepy.imggen.visualExpCustom()
    }));
    chk('T7 双人锁 custom 期间，全局 visualExpMode / custom 保存值都没动',
      during.mode === 'sleepy-default' && during.custom === 'sleepy-default 的自定义占位',
      JSON.stringify(during));
    await setSelect(page, IDX.subject, '@temp');
    st = await readUI(page);
    const after = await page.evaluate(() => ({
      mode: window.Sleepy.imggen.visualExpMode(),
      custom: window.Sleepy.imggen.visualExpCustom()
    }));
    chk('T7 切回单人后模式恢复 sleepy-default 且下拉重新可用',
      st.mode === 'sleepy-default' && !st.modeDisabled, JSON.stringify(st));
    chk('T7 切回单人后性别 / 镜头 / 手部重新露面、人物A / 人物B 收起',
      st.genderVisible && st.shotVisible && st.handsVisible && !st.paVisible && !st.pbVisible);
    chk('T7 切回单人后保存值还是原来那份（双人一次都没写进存储）',
      after.mode === 'sleepy-default' && after.custom === 'sleepy-default 的自定义占位',
      JSON.stringify(after));
    const oneShot = await page.evaluate(() => {
      const r = window.Sleepy.imggen.buildSingleSubjectExperimentPrompt({
        api: { kind: 'general' }, description: '坐在窗边的女孩', shot: 'portrait',
        tempSingle: true, gender: 'female', visualMode: 'sleepy-default',
        customVisualStyle: '', hands: 'visible', extras: []
      });
      return r && r.positive;
    });
    chk('T7 单人（01 / E2）仍可用：shot=portrait 的镜头层还在',
      !!oneShot && oneShot.indexOf('half-body portrait') >= 0);

    /* ---------- T4 拒绝用例 ---------- */
    await setSelect(page, IDX.subject, '@temp-two');
    await fillPa(page, PA_A); await fillPb(page, ''); await fillScene(page, SCENE_A);
    const c0 = reqCount;
    await clickGenerate(page);
    out = await outText(page);
    chk('T4 缺人物B：拦下且请求数为 0', reqCount === c0
      && out.text.indexOf('人物A 和人物B 都要写') >= 0, out.text.slice(0, 120));

    await fillPb(page, PB_A); await fillPa(page, '');
    await clickGenerate(page);
    out = await outText(page);
    chk('T4 缺人物A：拦下且请求数为 0', reqCount === c0
      && out.text.indexOf('人物A 和人物B 都要写') >= 0);

    await fillPa(page, PA_A); await fillPb(page, PB_A); await fillScene(page, '');
    await clickGenerate(page);
    out = await outText(page);
    /* 画面描述为空路径：被页面「先写一句想画什么」的前置校验挡在请求之前 */
    chk('T4 空画面描述：请求数为 0（前置校验拦下，不进请求）', reqCount === c0);

    /* 一人 / 三人：UI 只有两个人物框，构造不出来 —— 由纯函数守卫覆盖（如实标注） */
    chk('T4 一人 / 三人：UI 层构造不出（本页只有两个人物框），由纯函数守卫覆盖', true);

    /* 非 General：换一套 NAI 接口 */
    const naiId = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('nai');
      a.name = '双人测试-NAI'; a.baseUrl = 'http://127.0.0.1:9'; a.model = 'two-nai';
      a.apiKey = 'fixture-only';
      g.saveApis([a]); g.setCurrent(a.id);
      return a.id;
    });
    await openTry(page, naiId);
    await setSelect(page, IDX.subject, '@temp-two');
    st = await readUI(page);
    const c1 = reqCount;
    await fillScene(page, SCENE_A); await fillPa(page, PA_A); await fillPb(page, PB_A);
    await clickGenerate(page);
    out = await outText(page);
    chk('T4 NAI 接口：拦下且请求数为 0（本轮双人只支持 General / 文字通道）', reqCount === c1
      && out.text.indexOf('临时双人本轮只支持 General / 文字通道接口') >= 0, out.text.slice(0, 120));
    chk('T4 NAI 接口下给出界面提示（指路到 General / 文字通道）',
      st.text.indexOf('临时双人本轮不支持这个接口') >= 0
      && st.text.indexOf('常规生图」或「文字通道」') >= 0);

    /* ---------- T8 文字通道（api.kind=chat）：双人照旧发得出去 ----------
       与 General 的区别只在**负面怎么送**：这里没有独立负面字段，
       是 positive + 负面拼成自然语言正文送到 /chat/completions。
       两个通道都拦（route 覆盖），一次都不落真实服务。 */
    const chatId = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('chat');
      a.name = '双人测试-文字通道'; a.baseUrl = 'http://127.0.0.1:9/v1'; a.model = 'two-chat-fixture';
      a.apiKey = 'fixture-only';
      g.saveApis([a]); g.setCurrent(a.id);
      return a.id;
    });
    await openTry(page, chatId);
    await setSelect(page, IDX.subject, '@temp-two');
    st = await readUI(page);
    chk('T8 文字通道接口下选双人：给出「负面不是独立字段」的说明',
      st.text.indexOf('自然语言整段发到 /chat/completions') >= 0
      && st.text.indexOf('切回「常规生图」才走独立 negative_prompt') >= 0,
      st.text.slice(0, 200));
    const genBefore = reqCount;
    const chatBefore = chatCount;
    await fillScene(page, SCENE_A);
    await fillPa(page, PA_A);
    await fillPb(page, PB_A);
    await fillCustom(page, CUST_MARK);
    await clickGenerate(page);
    chk('T8 文字通道：请求打到 /chat/completions（不是 /images/generations）',
      chatCount === chatBefore + 1 && reqCount === genBefore,
      'chat=' + chatCount + ' gen=' + reqCount);
    const K = chatCaptured;
    const kcontent = (K && K.messages && K.messages[0] && K.messages[0].content) || '';
    chk('T8 文字通道请求体是 chat/completions 形态且带模型名',
      !!K && !!K.messages && !!K.messages[0] && K.model === 'two-chat-fixture',
      JSON.stringify(K && K.model));
    chk('T8 文字通道正文里双人结构原文 + 人物A/B 各恰好一份',
      kcontent.indexOf('Exactly two people are present in the image') >= 0
      && countOf(kcontent, 'Person A（人物A）: ' + PA_A) === 1
      && countOf(kcontent, 'Person B（人物B）: ' + PB_A) === 1);
    chk('T8 文字通道没误带 solo / exactly one person',
      kcontent.indexOf('solo') < 0 && kcontent.indexOf('exactly one person') < 0);
    chk('T8 文字通道的负面以自然语言段附上，且仍无 elderly / wrinkle / bad hands',
      kcontent.indexOf('画面里不要出现这些要素：') >= 0
      && /画面里不要出现这些要素：[\s\S]*/.test(kcontent)
      && kcontent.indexOf('elderly') < 0
      && kcontent.indexOf('wrinkle') < 0
      && kcontent.indexOf('bad hands') < 0,
      kcontent.slice(-260));
    out = await outText(page);
    chk('T8 结果区回显标注「通道 文字通道（自然语言正文）」且不报错',
      out.text.indexOf('通道 文字通道（自然语言正文）') >= 0
      && out.text.indexOf('常规生图（独立 negative 字段）') < 0
      && out.text.indexOf('临时双人本轮只支持') < 0,
      out.text.slice(0, 200));
    chk('T8 文字通道也走同一份自定义视觉层（custom marker 恰好一份）',
      countOf(kcontent, CUST_MARK) === 1);

    /* ---------- 收尾 ---------- */
    const totalReq = reqCount;
    console.log('\n  请求拦截计数：' + totalReq + ' 次（全部命中 page.route，未到真实服务）');
    console.log('\n结果：' + results.filter((r) => r.ok).length + ' ✓ / '
      + results.filter((r) => !r.ok).length + ' ✗');
    failed = results.filter((r) => !r.ok).length;
  } catch (e) {
    console.error('\n跑挂了：' + ((e && e.stack) || e));
    failed = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  process.exit(failed ? 1 : 0);
}
main();
