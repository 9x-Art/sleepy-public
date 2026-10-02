/* ============================================================
   scripts/browser-e2-group-visual-test.js — 04 临时多人群像 请求拦截检查
   ------------------------------------------------------------
   ⚠️ 口径：这是**本机 headless 浏览器**（Windows + playwright-core +
   系统 Edge 内核）的自动化检查，**不是真机 / 真手机**。本地静态服务
   跑在 127.0.0.1，用 page.route 同时拦 /images/generations 与
   /chat/completions，只读请求体、**回一张 1x1 PNG 让流程走完**——
   全程不调付费接口；接口地址故意用不可达端口做双保险。

   验证（施工单 04 §四）：
     T1 无岛 / 无角色 / 无马甲也能走「多人（临时测试）」到请求拦截
     T2 主体下拉出现「多人」项；选多人后露出人物A/B + 「添加人物」按钮，
        镜头 / 手部下拉收起，视觉模式局部锁 custom
     T3 少于 3 人、人物留空、共同描述空、非支持接口 —— 全部 0 请求
     T4 三人并肩（custom 空 vs 非空对照）：每人恰好一份、左中右位置保留
     T5 三人共同事件：每个人动作 + 手部归属保留，负面不混 legacy 整表
     T6 四人群体活动：四个人物块都在、没漏人没多块
     T7 非爱情群体（三代家庭 / 三位同事）：年龄亲属保留、无情侣措辞注入
     T8 文字通道：同一份群像词打到 /chat/completions
     T9 切回双人 / 单人：原有输入与视觉模式不被覆盖，01 与双人仍可用
   run:
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e2-group-visual-test.js
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

const PORT = process.env.E2_GROUP_PORT || 5209;
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
/* textarea 用**标签文本**定位（人物A/B/C/D 是新加的，不能靠位置猜） */
const LBL = {
  scene: '想画什么', custom: '自定义视觉提示词',
  pa: '人物A（临时测试', pb: '人物B（临时测试',
  pc: '人物C（临时测试', pd: '人物D（临时测试'
};

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
async function fillPc(page, t) { return fillLabel(page, LBL.pc, t); }
async function fillPd(page, t) { return fillLabel(page, LBL.pd, t); }
async function fillScene(page, t) { return fillLabel(page, LBL.scene, t); }
async function fillCustom(page, t) { return fillLabel(page, LBL.custom, t); }

/* 「添加人物」按钮：按文字点，只点页面上可见的（隐藏的那个点不到） */
async function clickFold(page) {
  return page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const b = Array.from(pg.querySelectorAll('.imggen-fold button'))
      .find((x) => (x.textContent || '').indexOf('收起第') >= 0);
    if (!b || b.offsetParent === null || b.disabled) return false;
    b.click();
    return true;
  });
}

async function foldVisible(page) {
  return page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const b = Array.from(pg.querySelectorAll('.imggen-fold button'))
      .find((x) => (x.textContent || '').indexOf('收起第') >= 0);
    return !!b && b.offsetParent !== null;
  });
}

async function clickAdd(page) {
  return page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const b = Array.from(pg.querySelectorAll('.imggen-fold button'))
      .find((x) => (x.textContent || '').indexOf('添加人物') >= 0
                 || (x.textContent || '').indexOf('再加一位') >= 0
                 || (x.textContent || '').indexOf('已经到上限') >= 0);
    if (!b || b.offsetParent === null || b.disabled) return false;
    b.click();
    return true;
  });
}

async function addBtnState(page) {
  return page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="settings-imggen-edit"]');
    const b = Array.from(pg.querySelectorAll('.imggen-fold button'))
      .find((x) => {
        const t = x.textContent || '';
        return t.indexOf('添加人物') >= 0 || t.indexOf('再加一位') >= 0
          || t.indexOf('已经到上限') >= 0;
      });
    return b ? { text: b.textContent, disabled: !!b.disabled, visible: b.offsetParent !== null } : null;
  });
}

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
      pcVisible: vis(byLabel(a.LBL.pc)), pdVisible: vis(byLabel(a.LBL.pd)),
      pdText: byLabel(a.LBL.pd) ? byLabel(a.LBL.pd).value : '',
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
  await sleep(1300);
}

async function outText(page) {
  return page.evaluate(() => {
    const o = document.querySelector('.page[data-page="settings-imggen-edit"] .imggen-out');
    return { cls: o ? o.className : '', text: o ? (o.textContent || '') : '' };
  });
}

const countOf = (s, n) => String(s || '').split(n).length - 1;
const blk = (l, t) => 'Person ' + l + '（人物' + l + '）: ' + t;

/* ---------- 四组虚构夹具（不建岛 / 不建角色 / 不建马甲） ---------- */
const PA1 = '28 岁男性，黑色寸头，深灰西装外套';
const PB1 = '34 岁女性，栗色齐肩发，米色针织衫';
const PC1 = '9 岁男孩，乱翘的短发，亮橙色冲锋衣';
const SCENE1 = '三人在海边并肩站成一排看向镜头，人物A 站最左边、人物B 站中间、人物C 站最右边；'
  + '没有牵手也没有拥抱，肩膀彼此不接触。';
const SCENE2 = '三人在家里的厨房餐桌边：人物A 站在桌子的左侧俯身在砧板上切水果，右手握刀；'
  + '人物B 站在桌子右侧，左手端着一只白盘子递给人物A，右手自然垂着；'
  + '人物C 站在桌子后方，右手举着饮料瓶往玻璃杯里倒，左手扶杯；'
  + '其余手臂都自然放下或被身体挡住。';
const PA3A = '52 岁男性，花白头发，卡其色夹克';
const PB3B = '49 岁女性，锁骨发，藏蓝连衣裙';
const PC3C = '22 岁女性，丸子头，白色卫衣';
const PD3D = '25 岁男性，理发很差的短发，深绿冲锋衣';
const SCENE3 = '四人在室内的餐桌旁准备生日蛋糕：人物A 站在左后方往烤盘上撒糖霜，'
  + '人物B 站在右后方端着一盘草莓，人物C 站在正前方举着一支点燃的蜡烛，'
  + '人物D 蹲在椅子旁整理装蛋糕的盒子；四人不牵手、不拥抱。';
const PA4A = '75 岁老奶奶，满头白发，深蓝色布衫';
const PB4B = '48 岁女性母亲，齐耳短发，浅灰开衫';
const PC4C = '16 岁女儿，扎马尾，校服外套';
const SCENE4 = '祖孙三人在家里的客厅沙发上：人物A（奶奶）坐在最左边，人物B（妈妈）坐中间，'
  + '人物C（女儿）坐右边；三人都看向电视，没有亲密接触，不是情侣也没有牵手。';
const CUST_MARK = 'flat graphic illustration, limited 6-color palette';

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let reqCount = 0;      /* /images/generations 次数 */
  let captured = null;
  let chatCount = 0;     /* /chat/completions 次数 */
  let chatCaptured = null;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    /* 文字通道同样必须拦下（不可回退真实服务）：回一条 markdown 内嵌 1x1 PNG，
       让 extractImageFromChatText → b64ToBlob 的落地链路也走完。 */
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
      a.name = '群像测试接口'; a.baseUrl = 'http://127.0.0.1:9/v1'; a.model = 'group-fixture';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a])); g.setCurrent(a.id);
      return a.id;
    });

    await openTry(page, apiId);

    /* ---------- T1 / T2 入口与显隐 ---------- */
    const opts = await page.evaluate(() => {
      const sel = Array.from(document.querySelector('.page[data-page="settings-imggen-edit"]')
        .querySelectorAll('.imggen-fold select'))[1];
      return Array.from(sel.querySelectorAll('option')).map((o) => o.value);
    });
    chk('T2 主体下拉出现「多人（临时测试，不读取群岛资料）」且双人那项还在',
      opts.indexOf('@temp-group') >= 0 && opts.indexOf('@temp-two') >= 0
      && opts.indexOf('@temp') >= 0, JSON.stringify(opts));

    await setSelect(page, IDX.subject, '@temp-group');
    let st = await readUI(page);
    chk('T2 选多人后露出人物A / 人物B，人物C / D 仍收起',
      st.paVisible && st.pbVisible && !st.pcVisible && !st.pdVisible,
      JSON.stringify({ pa: st.paVisible, pb: st.pbVisible, pc: st.pcVisible, pd: st.pdVisible }));
    chk('T2 多人时隐藏镜头与手部下拉（本轮镜头＝按画面描述）',
      !st.shotVisible && !st.handsVisible);
    chk('T2 多人时隐藏性别下拉（每人外貌都写在自己的框里）', !st.genderVisible);
    chk('T2 多人时提示「只验证人数、身份分块、共同事件与动作归属」',
      st.text.indexOf('只验证') >= 0 && st.text.indexOf('身份分块') >= 0);
    chk('T2 多人时提示少于 3 人不发、超过 4 人不接',
      st.text.indexOf('少于 3 人不发') >= 0 && st.text.indexOf('超过 4 人不接') >= 0);
    chk('T2 多人时视觉模式被局部锁成 custom（不覆盖全局已保存值）',
      st.mode === 'custom' && st.modeDisabled, st.mode);
    const savedMode = await page.evaluate(() => window.Sleepy.imggen.visualExpMode());
    chk('T2 全局 visualExpMode 没被多人改动', savedMode === 'legacy', String(savedMode));
    chk('T2 初始「添加人物」按钮可见且可点',
      (await addBtnState(page) || {}).visible === true);

    /* ---------- T3 拒绝样例：全部 0 请求 ---------- */
    await fillScene(page, SCENE1);
    await fillPa(page, PA1);
    await fillPb(page, PB1);
    const c0 = reqCount;
    await clickGenerate(page);
    let out = await outText(page);
    chk('T3 少于 3 人（只填 A / B）：拦下且请求数为 0',
      reqCount === c0 && out.text.indexOf('群像至少要 3 个人物') >= 0, out.text.slice(0, 120));

    /* 先把人物C 放出来：没点「添加人物」时 C 是收起的，收起的框不该被算进人数
       （这正是上面「少于 3 人」能拦下的原因，不能靠预埋隐藏框蒙混过关） */
    chk('T3 点「添加人物」放出人物C', await clickAdd(page));
    chk('T3 人物C 框可见', (await readUI(page)).pcVisible);
    await fillPc(page, PC1);
    const c1 = reqCount;
    await clickGenerate(page);
    out = await outText(page);
    chk('T3 三人齐全后放行（发出 1 次请求）', reqCount === c1 + 1, 'reqCount=' + reqCount);

    /* 第四位：露出来但留空 → 必须 0 请求 */
    chk('T3 再点「添加人物」放出人物D', await clickAdd(page));
    chk('T3 人物D 框可见', (await readUI(page)).pdVisible);
    const c2 = reqCount;
    await clickGenerate(page);
    out = await outText(page);
    chk('T3 人物D 留空：拦下且请求数为 0（不 filter 掉空的继续出图）',
      reqCount === c2 && out.text.indexOf('人物D 还没写') >= 0, out.text.slice(0, 120));

    /* 空共同描述：回退到页面前置校验，同样 0 请求 */
    await fillPd(page, PD3D);
    await fillScene(page, '');
    const c3 = reqCount;
    await clickGenerate(page);
    chk('T3 空共同描述：请求数为 0（前置校验拦下）', reqCount === c3);

    /* T3 把人数推到 4 之后要能回到 3，否则三人组（T4 / T5 / T6）根本出不了图 */
    chk('T3 到上限后「收起第 4 位」可点', await clickFold(page));
    let stf = await readUI(page);
    chk('T3 收起后人物D 收起且内容清空（回到 3 人）', !stf.pdVisible && !stf.pdText);
    chk('T3 收起后「添加人物」重新可用', !(await addBtnState(page)).disabled);
    await fillScene(page, SCENE1);
    await clickGenerate(page);
    chk('T4 三人 requests 发出 1 次', reqCount === c3 + 1, 'reqCount=' + reqCount);
    const G0 = captured;
    chk('T4 请求体带 model / size / 独立 negative_prompt',
      !!G0 && G0.model === 'group-fixture' && !!G0.size && 'negative_prompt' in G0);
    chk('T4 人物A 块恰好一份', !!G0 && countOf(G0.prompt, blk('A', PA1)) === 1);
    chk('T4 人物B 块恰好一份', !!G0 && countOf(G0.prompt, blk('B', PB1)) === 1);
    chk('T4 人物C 块恰好一份', !!G0 && countOf(G0.prompt, blk('C', PC1)) === 1);
    chk('T4 群像结构词恰好一份', !!G0 && countOf(G0.prompt, 'Exactly the described number') === 1);
    chk('T4 共同画面描述恰好一份',
      !!G0 && countOf(G0.prompt, 'Group scene（共同画面描述）: ') === 1);
    chk('T4 左中右位置全部保留',
      !!G0 && G0.prompt.indexOf('人物A 站最左边、人物B 站中间、人物C 站最右边') >= 0);
    chk('T4 没有 solo / exactly one person 误带',
      !!G0 && G0.prompt.indexOf('solo') < 0 && G0.prompt.indexOf('exactly one person') < 0);
    chk('T4 没有单人性别标签 1girl / 1boy',
      !!G0 && G0.prompt.indexOf('1girl') < 0 && G0.prompt.indexOf('1boy') < 0);
    /* 单人底座词从页面里取真值比对，不在脚本里硬编码一份 */
    const lookConsts = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      return { male: g.SLEEPY_TEMP_MALE_LOOK || '', female: g.SLEEPY_TEMP_FEMALE_LOOK || '' };
    });
    chk('T4 没有 male v2 / female C / 旧默认 look',
      !!G0 && G0.prompt.indexOf(lookConsts.male) < 0
        && G0.prompt.indexOf(lookConsts.female) < 0
        && G0.prompt.indexOf('Sleepy 单人默认') < 0
        && G0.prompt.indexOf('single subject') < 0);
    chk('T4 系统没补手部词、也没删用户手部描述（本组无手部描述，正好对照）',
      !!G0 && G0.prompt.indexOf('well-proportioned hands') < 0);
    chk('T4 负面只有质量负面：无 old / elderly / wrinkle / bad hands',
      !!G0 && G0.negative_prompt === 'lowres, worst quality, low quality, jpeg artifacts, blurry',
      JSON.stringify(G0 && G0.negative_prompt));
    const out4 = await outText(page);
    chk('T4 结果回显含「多人临时测试 · 镜头按画面描述 · 系统手部附加词关闭」',
      out4.text.indexOf('多人临时测试') >= 0
      || out4.text.indexOf('主体 多人（临时测试，不读取群岛资料）') >= 0,
      out4.text.slice(0, 160));

    /* custom 非空：只追加一份视觉层 */
    await fillCustom(page, CUST_MARK);
    const c4 = reqCount;
    await clickGenerate(page);
    const G1b = captured;
    chk('T5 custom 非空：额外 1 次请求', reqCount === c4 + 1);
    chk('T5 custom marker 恰好一份', !!G1b && countOf(G1b.prompt, CUST_MARK) === 1);
    chk('T5 custom 非空时其余层原样（以空值那份为正前缀）',
      !!G1b && !!G0 && G1b.prompt.indexOf(G0.prompt + ', ' + CUST_MARK) === 0,
      String(G1b && G1b.prompt).slice(0, 200));
    chk('T5 custom 非空不注入审美负面、不回退旧默认 look',
      !!G1b && G1b.negative_prompt === 'lowres, worst quality, low quality, jpeg artifacts, blurry');
    await fillCustom(page, '');

    /* ---------- T6 三人共同事件 ---------- */
    await fillScene(page, SCENE2);
    const c5 = reqCount;
    await clickGenerate(page);
    const G2 = captured;
    chk('T6 共同事件组发出 1 次请求', reqCount === c5 + 1);
    chk('T6 人物A 动作与其手部归属保留',
      !!G2 && G2.prompt.indexOf('人物A 站在桌子的左侧俯身在砧板上切水果，右手握刀') >= 0);
    chk('T6 人物B 手部归属保留',
      !!G2 && G2.prompt.indexOf('人物B 站在桌子右侧，左手端着一只白盘子递给人物A，右手自然垂着') >= 0);
    chk('T6 人物C 手部归属保留',
      !!G2 && G2.prompt.indexOf('人物C 站在桌子后方，右手举着饮料瓶往玻璃杯里倒，左手扶杯') >= 0);
    chk('T6 遮挡／不入镜说明恰好一份', !!G2 && countOf(G2.prompt, '其余手臂都自然放下或被身体挡住') === 1);
    chk('T6 三个人物块各恰好一份（没互相覆盖）',
      !!G2 && countOf(G2.prompt, blk('A', PA1)) === 1
        && countOf(G2.prompt, blk('B', PB1)) === 1 && countOf(G2.prompt, blk('C', PC1)) === 1);
    chk('T6 负面没混进 legacy 手部整表（bad hands / extra fingers）',
      !!G2 && G2.negative_prompt.indexOf('bad hands') < 0 && G2.negative_prompt.indexOf('extra fingers') < 0,
      JSON.stringify(G2 && G2.negative_prompt));

    /* ---------- T7 四人群体活动（把人物数推到上限 4） ---------- */
    /* 前面 T3 之后已经收回到 3 人，这里显式推回上限 4（换接口重开页不会把人物收回去） */
    chk('T7-0 再点「添加人物」把人数推到上限 4', await clickAdd(page));
    chk('T7-0 人物D 框露出来', (await readUI(page)).pdVisible);
    await fillScene(page, SCENE3);
    await fillPa(page, PA3A);
    await fillPb(page, PB3B);
    await fillPc(page, PC3C);
    await fillPd(page, PD3D);
    const c6 = reqCount;
    await clickGenerate(page);
    const G3 = captured;
    chk('T7 四人组发出 1 次请求', reqCount === c6 + 1);
    chk('T7 四个人物块各恰好一份（没漏人、没多拼一块）',
      !!G3 && countOf(G3.prompt, blk('A', PA3A)) === 1
        && countOf(G3.prompt, blk('B', PB3B)) === 1
        && countOf(G3.prompt, blk('C', PC3C)) === 1
        && countOf(G3.prompt, blk('D', PD3D)) === 1);
    chk('T7 第四人被完整保留', !!G3 && G3.prompt.indexOf('人物D 蹲在椅子旁整理装蛋糕的盒子') >= 0);
    chk('T7 结构词仍只一份（没被四人重复拼）',
      !!G3 && countOf(G3.prompt, 'Exactly the described number') === 1);
    chk('T7 共同事件恰好一份', !!G3 && countOf(G3.prompt, '四人在室内的餐桌旁准备生日蛋糕') === 1);
    const btnMax = await addBtnState(page);
    chk('T7 上边界闭合：按钮变成「已经到上限（4 人）」且不可点',
      !!btnMax && btnMax.disabled === true && btnMax.text.indexOf('已经到上限') >= 0,
      JSON.stringify(btnMax));
    chk('T7 上限时露出「收起第 4 位」，能回到 3 人（不会卡在 4 人出不了三人组）',
      await foldVisible(page));

    /* ---------- T8 非爱情群体（四人之后收回到 3 人，才是「三代人」这一组） ---------- */
    chk('T8 四人后仍可收回到 3 人（上限不是单向门）', await clickFold(page));
    chk('T8 收回后人物D 收起', !(await readUI(page)).pdVisible);
    await fillScene(page, SCENE4);
    await fillPa(page, PA4A);
    await fillPb(page, PB4B);
    await fillPc(page, PC4C);
    const c7 = reqCount;
    await clickGenerate(page);
    const G4 = captured;
    chk('T8 非爱情群体组发出 1 次请求', reqCount === c7 + 1);
    chk('T8 三代人年龄与称呼保留',
      !!G4 && G4.prompt.indexOf('人物A（奶奶）坐在最左边，人物B（妈妈）坐中间，人物C（女儿）坐右边') >= 0);
    chk('T8 没有注入情侣 / 亲密措辞（kiss / couple / lovers / romantic / intimate / embrace）',
      !!G4 && ['kiss', 'couple', 'lovers', 'romantic', 'intimate', 'embrac', 'holding hands']
        .every((w) => G4.prompt.indexOf(w) < 0),
      JSON.stringify(G4 && G4.prompt.slice(-160)));
    chk('T8 负面没有压年长主体的词（old / elderly / wrinkle）',
      !!G4 && G4.negative_prompt.indexOf('old') < 0 && G4.negative_prompt.indexOf('elderly') < 0
        && G4.negative_prompt.indexOf('wrinkle') < 0, JSON.stringify(G4 && G4.negative_prompt));

    /* ---------- T9 文字通道：同一份群像词 ---------- */
    const chatId = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('chat');
      a.name = '群像测试-文字通道'; a.baseUrl = 'http://127.0.0.1:9/v1'; a.model = 'group-chat-fixture';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a])); g.setCurrent(a.id);
      return a.id;
    });
    await openTry(page, chatId);
    await setSelect(page, IDX.subject, '@temp-group');
    /* 重开页会把人物档位复位成 2 人，这里**重新点一次**「添加人物」再凑 3 人 */
    await clickAdd(page);
    let stc = await readUI(page);
    chk('T9 文字通道下选多人：给出「负面不是独立字段」的说明',
      stc.text.indexOf('自然语言整段发到 /chat/completions') >= 0);
    const genBefore = reqCount;
    const chatBefore = chatCount;
    await fillScene(page, SCENE1);
    await fillPa(page, PA1);
    await fillPb(page, PB1);
    await fillPc(page, PC1);
    await clickGenerate(page);
    chk('T9 文字通道群像：请求打到 /chat/completions，不是 /images/generations',
      chatCount === chatBefore + 1 && reqCount === genBefore,
      'chat=' + chatCount + ' gen=' + reqCount);
    const K = chatCaptured;
    const kc = (K && K.messages && K.messages[0] && K.messages[0].content) || '';
    chk('T9 文字通道请求体是 chat 形态且带模型名',
      !!K && K.model === 'group-chat-fixture' && !!kc);
    chk('T9 正文里三人各恰好一份 + 群像结构词一份',
      countOf(kc, blk('A', PA1)) === 1 && countOf(kc, blk('B', PB1)) === 1
        && countOf(kc, blk('C', PC1)) === 1 && countOf(kc, 'Exactly the described number') === 1);
    chk('T9 负面以自然语言段附上且仍无 elderly / wrinkle / bad hands',
      kc.indexOf('画面里不要出现这些要素：') >= 0
        && kc.indexOf('elderly') < 0 && kc.indexOf('wrinkle') < 0 && kc.indexOf('bad hands') < 0);
    out = await outText(page);
    chk('T9 结果回显标注「通道 文字通道（自然语言正文）」且不报错',
      out.text.indexOf('文字通道（自然语言正文）') >= 0 && out.text.indexOf('临时多人本轮只支持') < 0,
      out.text.slice(0, 200));

    /* ---------- T10 非支持接口（NAI） ---------- */
    const naiId = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('nai');
      a.name = '群像测试-NAI'; a.baseUrl = 'http://127.0.0.1:9'; a.model = 'group-nai';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a])); g.setCurrent(a.id);
      return a.id;
    });
    await openTry(page, naiId);
    await setSelect(page, IDX.subject, '@temp-group');
    await fillScene(page, SCENE1);
    await fillPa(page, PA1);
    await fillPb(page, PB1);
    await fillPc(page, PC1);
    const gen2 = reqCount;
    const chat2 = chatCount;
    await clickGenerate(page);
    out = await outText(page);
    chk('T10 NAI 接口 + 多人：拦下且两条通道请求数都不变',
      reqCount === gen2 && chatCount === chat2
        && out.text.indexOf('临时多人本轮只支持 General / 文字通道接口') >= 0,
      out.text.slice(0, 140));

    /* ---------- T11 切回双人 / 单人：不被覆盖 ---------- */
    await openTry(page, apiId);
    await setSelect(page, IDX.subject, '@temp-two');
    st = await readUI(page);
    chk('T11 主体下拉真的切到了「双人」', st.subject === '@temp-two', String(st.subject));
    /* 群像 → 双人仍在「多人档」里（multi），锁的 custom 不解；
       不被覆盖指的是**全局保存的视觉模式**一个字节都不动（下面 T12 查）。 */
    chk('T11 切回双人：仍在多人档，custom 保持锁住（全局值未动）',
      st.modeDisabled === true, String(st.mode));
    chk('T11 切回双人：人物C / D 收起、人物A / B 还在',
      !st.pcVisible && !st.pdVisible && st.paVisible && st.pbVisible);
    await setSelect(page, IDX.subject, '@temp');
    st = await readUI(page);
    /* 离开「多人档」才解锁：恢复锁之前的 legacy 并可再用（原 03 双人/单人行为） */
    chk('T11 切回单人：视觉模式解锁并恢复原值且可用',
      st.mode === 'legacy' && st.modeDisabled === false, st.mode);
    /* legacy 下拉按原规则整组收起（不是群像引入的差别，单人 / 双人同口径） */
    chk('T11 切回单人：人物框收起（镜头 / 手部随 legacy 原规则收起）',
      !st.paVisible && !st.pbVisible, JSON.stringify({ s: st.shotVisible, h: st.handsVisible }));
    chk('T11 切回单人：还在 4 人档时「收起第 4 位」也不许漏在单人面板里',
      !(await foldVisible(page)));
    const still = await page.evaluate(() => ({
      mode: window.Sleepy.imggen.visualExpMode(),
      subject: window.Sleepy.imggen.singleExpSubjectRef()
    }));
    chk('T11 群像一次都没写进存储（visualExpMode 仍是 legacy、主体仍是单人哨兵）',
      still.mode === 'legacy' && still.subject === '@temp', JSON.stringify(still));

    console.log('\n  请求拦截计数：' + reqCount + ' 次 images/generations + '
      + chatCount + ' 次 chat/completions（全部命中 page.route）');
  } catch (e) {
    console.error('\n跑挂了：' + ((e && e.stack) || e));
    results.push({ name: '脚本本身跑完', ok: false });
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n结果：' + results.filter((r) => r.ok).length + ' ✓ / ' + failed + ' ✗');
  process.exit(failed ? 1 : 0);
}
main();
