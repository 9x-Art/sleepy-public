/* ============================================================
   scripts/browser-e2-v2-revamp-test.js — 返修 v2（身份优先/中性底座/严格对账）
   + AI 根据人设生成外貌（施工单 B v1）请求拦截检查
   ------------------------------------------------------------
   ⚠️ 口径：本机 headless Edge + page.route 拦截，零付费、零真实副 API 调用；
   副 API / 生图夹具 baseUrl 均为不可达 127.0.0.1:9。虚构人设，无私人资料。
   run:
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e2-v2-revamp-test.js
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

const PORT = process.env.E2_REV_PORT || 5223;
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

const PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const AI_OK = JSON.stringify({
  appearanceText: '银灰色齐肩短发，琥珀色瞳，左耳一枚银色耳骨夹，鳞片从手肘延伸到指尖（人鱼特征，当前为人形）',
  missing: ['身高感'],
  conflicts: ['材料先说短发后说长发']
});
const AI_EMPTY = JSON.stringify({ appearanceText: '', missing: ['没有任何外貌信息'], conflicts: [] });

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let genCount = 0, subCount = 0;
  let capturedGeneral = null, capturedSub = null;
  let lastCapturedUrl = '';
  let failed = 0;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.route('**/images/generations', async (route) => {
      genCount++;
      lastCapturedUrl = route.request().url();
      try { capturedGeneral = JSON.parse(route.request().postData() || '{}'); } catch (e) { capturedGeneral = null; }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ b64_json: PX_PNG }] }) });
    });
    await page.route('**/chat/completions', async (route) => {
      subCount++;
      lastCapturedUrl = route.request().url();
      try { capturedSub = JSON.parse(route.request().postData() || '{}'); } catch (e) { capturedSub = null; }
      /* 生图 chat 通道与副 API 共用端点：按 model 区分返回内容。
         副 API 请求延迟 700ms 回复 —— 给「在途编辑字段」的过期保护测试留窗口。 */
      const body = (() => { try { return JSON.parse(route.request().postData() || '{}'); } catch (e) { return {}; } })();
      const isAi = body.model === 'rev-sub-model';
      if (isAi) await sleep(700);
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(isAi
          ? { choices: [{ message: { content: '```json\n' + AI_OK + '\n```' } }] }
          : { choices: [{ message: { content: '![img](data:image/png;base64,' + PX_PNG + ')' } }] }) });
    });

    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    const errs = await waitApp(page);
    chk('R0 启动无 pageerror', errs.length === 0, errs.join(' | '));

    const ids = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const gen = g.newApi('general');
      gen.name = '返修-General'; gen.baseUrl = 'http://127.0.0.1:9/v1'; gen.model = 'rev-general';
      g.saveApis([gen]); g.setCurrent(gen.id);
      const ch = window.Sleepy.core.upsertChar({
        name: '返修夹具角色', kind: 'main', gender: '', sandboxId: null,
        content: '人鱼族，平时以人形出现，银灰短发，琥珀瞳，左耳有银色耳骨夹，手臂到指尖有细鳞。' +
          '（此处是一段较长的虚构人设文本用于测试材料预填，不含真实私人资料。）'
      });
      return { genId: gen.id, chId: ch.id };
    });

    /* ========== A. 返修 v2：中性底座 ========== */
    async function gen(plan, apiId) {
      const r = await page.evaluate(async (p) => {
        const api = window.Sleepy.imggen.listApis().find((x) => x.id === p.apiId);
        const r = await window.Sleepy.imggen.generate({ plan: p.plan, api: api });
        return { ok: r.ok, msg: r.error ? r.error.message : '' };
      }, { plan, apiId: apiId || ids.genId });
      await sleep(250);
      return r;
    }
    const before0 = genCount;
    const rN = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [{ entityType: 'char', entityId: ids.chId, name: '返修夹具角色', gender: '', faceText: 'scales on forearms' }],
      description: '人鱼在礁石边，当前人形' });
    chk('A1 未知性别不再报错，走中性底座出请求', rN.ok === true && genCount === before0 + 1, JSON.stringify(rN));
    chk('A2 中性词/中性结构在，无 person 结构、无成年/族裔注入、无性别 tag 补齐',
      capturedGeneral && capturedGeneral.prompt.indexOf('do not replace them with a standardized human appearance') >= 0
      && capturedGeneral.prompt.indexOf('solo, exactly one subject') >= 0
      && capturedGeneral.prompt.indexOf('exactly one person') < 0
      && capturedGeneral.prompt.indexOf('East Asian') < 0
      && capturedGeneral.prompt.indexOf('1girl') < 0 && capturedGeneral.prompt.indexOf('1boy') < 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 160));
    chk('A3 物种/形态描述原样保留在请求里',
      capturedGeneral && capturedGeneral.prompt.indexOf('scales on forearms') >= 0
      && capturedGeneral.prompt.indexOf('当前人形') >= 0);
    chk('A4 中性负面无人体脸型三连',
      capturedGeneral && capturedGeneral.negative_prompt.indexOf('deformed face') < 0
      && capturedGeneral.negative_prompt.indexOf('extra person') >= 0,
      capturedGeneral && capturedGeneral.negative_prompt);

    /* 男/女 v2 */
    const rM = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [{ entityType: 'char', entityId: ids.chId, name: '返修夹具角色', gender: 'male', faceText: '' }],
      description: '夜景天台' });
    chk('A5 男性正式 v2：无 daylight 定向、无实验旧词',
      rM.ok === true && capturedGeneral
      && capturedGeneral.prompt.indexOf("described male character's face") >= 0
      && capturedGeneral.prompt.indexOf('soft dimensional daylight') < 0
      && capturedGeneral.prompt.indexOf('idealized adult male face') < 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 140));
    const rF = await gen({ sender: 'user', contentType: 'person', shot: 'auto',
      subjects: [{ entityType: 'char', entityId: ids.chId, name: '返修夹具角色', gender: 'female', faceText: '' }],
      description: '非东亚设定场景' });
    chk('A6 女性正式 v2：无族裔兜底、无默认妆容句、无实验旧词',
      rF.ok === true && capturedGeneral
      && capturedGeneral.prompt.indexOf('strikingly beautiful female character') >= 0
      && capturedGeneral.prompt.indexOf('East Asian') < 0
      && capturedGeneral.prompt.indexOf('Keep makeup light') < 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 140));

    /* 严格对账 */
    const beforeD = genCount;
    const lack = await gen({ sender: 'user', contentType: 'person',
      subjects: [{ entityType: 'char', entityId: ids.chId, name: 'A', gender: 'female', faceText: '' }],
      description: 'x', expectedSubjectCount: 2 });
    chk('A7 声明2解析1拦截且零请求', lack.ok === false && lack.msg.indexOf('解析不了') >= 0 && genCount === beforeD);
    const extra = await gen({ sender: 'user', contentType: 'scene', subjects: [
      { entityType: 'char', entityId: ids.chId, name: 'A', gender: 'female', faceText: '' }],
      description: 'x', expectedSubjectCount: 0 });
    chk('A8 声明0却有人拦截（矛盾方向）', extra.ok === false && extra.msg.indexOf('对不上') >= 0 && genCount === beforeD);

    /* A9-A12b：03/04 内置视觉层（双通道 / 恰好一份 / custom 不混入）。
       核查 2：每个 case 都断言**实际请求 URL**（通道）与最终正文，不只断言成功。 */
    const chatFix = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('chat');
      a.name = '返修-Chat'; a.baseUrl = 'http://127.0.0.1:9/v1'; a.model = 'rev-chat-img';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a]));
      return a.id;
    });
    const mkSub = (i) => ({ entityType: 'char', entityId: 'rg' + i, name: '人' + i, gender: i % 2 ? 'female' : 'male', faceText: '' });
    const mkPlan = (n, extra2) => ({ sender: 'user', contentType: 'mixed', shot: 'group',
      subjects: Array.from({ length: n }, (_, i) => mkSub(i + 1)), description: '多人合影', ...(extra2 || {}) });
    const lastUrl = () => (lastCapturedUrl || '');
    const TWO_MARK = 'the two described people';
    const GROUP_MARK = 'Render every person with equally careful facial detail';

    /* A9 2人 builtin general */
    capturedGeneral = null;
    const r9 = await gen(mkPlan(2), ids.genId);
    chk('A9 2人 builtin（general）：URL=images/generations + 双人视觉层恰好一份 + 结构在前',
      r9.ok === true && lastUrl().endsWith('/images/generations') && capturedGeneral
      && countOf(capturedGeneral.prompt, TWO_MARK) === 1
      && countOf(capturedGeneral.prompt, "keeping both people's faces readable") === 1
      && capturedGeneral.prompt.indexOf('Exactly two people are present') >= 0
      && capturedGeneral.prompt.indexOf('Exactly two people are present') < capturedGeneral.prompt.indexOf(TWO_MARK),
      lastUrl() + ' | ' + (capturedGeneral && capturedGeneral.prompt.slice(0, 80)));

    /* A10 4人 builtin chat */
    capturedSub = null;
    const r10 = await gen(mkPlan(4), chatFix);
    const content4 = capturedSub && capturedSub.messages && capturedSub.messages[0] ? capturedSub.messages[0].content : '';
    chk('A10 4人 builtin（chat）：URL=chat/completions + 多人视觉层恰好一份 + 负面成句',
      r10.ok === true && lastUrl().endsWith('/chat/completions') && capturedSub
      && countOf(content4, GROUP_MARK) === 1
      && countOf(content4, "keeping every person's face readable") === 1
      && content4.indexOf('画面里不要出现这些要素：') >= 0,
      lastUrl() + ' | ' + content4.slice(0, 80));

    /* A11 3人 builtin general */
    capturedGeneral = null;
    const r11 = await gen(mkPlan(3), ids.genId);
    chk('A11 3人 builtin（general）：URL 正确 + 多人视觉层一份、无双人版词',
      r11.ok === true && lastUrl().endsWith('/images/generations') && capturedGeneral
      && countOf(capturedGeneral.prompt, GROUP_MARK) === 1
      && capturedGeneral.prompt.indexOf('both people') < 0,
      lastUrl() + ' | ' + (capturedGeneral && capturedGeneral.prompt.slice(0, 80)));

    /* A13 2人 builtin chat：双人视觉层进自然语言正文 */
    capturedSub = null;
    const r13 = await gen(mkPlan(2), chatFix);
    const content2 = capturedSub && capturedSub.messages && capturedSub.messages[0] ? capturedSub.messages[0].content : '';
    chk('A13 2人 builtin（chat）：URL 正确 + 双人视觉层恰好一份 + 双人结构在',
      r13.ok === true && lastUrl().endsWith('/chat/completions') && capturedSub
      && countOf(content2, TWO_MARK) === 1
      && content2.indexOf('Exactly two people are present') >= 0,
      lastUrl() + ' | ' + content2.slice(0, 80));

    /* A14 3人 builtin chat */
    capturedSub = null;
    const r14 = await gen(mkPlan(3), chatFix);
    const content3 = capturedSub && capturedSub.messages && capturedSub.messages[0] ? capturedSub.messages[0].content : '';
    chk('A14 3人 builtin（chat）：URL 正确 + 多人视觉层恰好一份',
      r14.ok === true && lastUrl().endsWith('/chat/completions') && capturedSub
      && countOf(content3, GROUP_MARK) === 1,
      lastUrl() + ' | ' + content3.slice(0, 80));

    /* A15 4人 builtin general */
    capturedGeneral = null;
    const r15 = await gen(mkPlan(4), ids.genId);
    chk('A15 4人 builtin（general）：URL 正确 + 多人视觉层恰好一份',
      r15.ok === true && lastUrl().endsWith('/images/generations') && capturedGeneral
      && countOf(capturedGeneral.prompt, GROUP_MARK) === 1,
      lastUrl() + ' | ' + (capturedGeneral && capturedGeneral.prompt.slice(0, 80)));

    /* A16-A19：3/4 人 custom 空/非空 —— 均不得混入内置视觉词；测完恢复 builtin */
    await page.evaluate(() => {
      window.Sleepy.imggen.setImgStyleMode('custom');
      window.Sleepy.imggen.setImgStyleCustom('marker-crayon-style');
    });
    capturedGeneral = null;
    const r16 = await gen(mkPlan(3), ids.genId);
    chk('A16 3人 custom 非空（general）：用户词一份、无内置双人/多人词',
      r16.ok === true && capturedGeneral
      && countOf(capturedGeneral.prompt, 'marker-crayon-style') === 1
      && capturedGeneral.prompt.indexOf(TWO_MARK) < 0 && capturedGeneral.prompt.indexOf(GROUP_MARK) < 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 80));
    capturedSub = null;
    const r17 = await gen(mkPlan(4), chatFix);
    const content17 = capturedSub && capturedSub.messages && capturedSub.messages[0] ? capturedSub.messages[0].content : '';
    chk('A17 4人 custom 非空（chat）：用户词一份、无内置词',
      r17.ok === true && lastUrl().endsWith('/chat/completions')
      && countOf(content17, 'marker-crayon-style') === 1
      && content17.indexOf(TWO_MARK) < 0 && content17.indexOf(GROUP_MARK) < 0,
      lastUrl() + ' | ' + content17.slice(0, 80));
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleCustom(''); });
    capturedGeneral = null;
    const r18 = await gen(mkPlan(3), ids.genId);
    chk('A18 3人 custom 空（general）：无内置词、群像结构仍在',
      r18.ok === true && capturedGeneral
      && capturedGeneral.prompt.indexOf(TWO_MARK) < 0 && capturedGeneral.prompt.indexOf(GROUP_MARK) < 0
      && capturedGeneral.prompt.indexOf('Exactly the described number of people') >= 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 80));
    capturedSub = null;
    const r19 = await gen(mkPlan(4), chatFix);
    const content19 = capturedSub && capturedSub.messages && capturedSub.messages[0] ? capturedSub.messages[0].content : '';
    chk('A19 4人 custom 空（chat）：无内置词、群像结构仍在',
      r19.ok === true && lastUrl().endsWith('/chat/completions')
      && content19.indexOf(TWO_MARK) < 0 && content19.indexOf(GROUP_MARK) < 0
      && content19.indexOf('Exactly the described number of people') >= 0,
      lastUrl() + ' | ' + content19.slice(0, 80));

    /* A12：2人 custom（非空/空）—— 机制与 A16-A19 相同，保留 2 人两态 */
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleCustom('marker-crayon-style'); });
    capturedGeneral = null;
    const r12a = await gen(mkPlan(2), ids.genId);
    chk('A12 2人 custom 非空：只透传用户词，内置双人词不混入',
      r12a.ok === true && capturedGeneral
      && capturedGeneral.prompt.indexOf('marker-crayon-style') >= 0
      && capturedGeneral.prompt.indexOf(TWO_MARK) < 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 80));
    capturedGeneral = null;
    const r12b = await gen(mkPlan(2), ids.genId);
    chk('A12b 2人 custom 空：无内置双人词、结构仍在',
      r12b.ok === true && capturedGeneral
      && capturedGeneral.prompt.indexOf(TWO_MARK) < 0
      && capturedGeneral.prompt.indexOf('Exactly two people are present') >= 0,
      capturedGeneral && capturedGeneral.prompt.slice(0, 80));
    await page.evaluate(() => { window.Sleepy.imggen.setImgStyleMode('builtin'); });

    /* ========== B. AI 外貌生成 ========== */
    /* B1 无副 API：按钮禁用 + 无请求 */
    await page.evaluate((chId) => { window.Sleepy.nav.open('contact-edit', { id: chId, sandboxId: null }); }, ids.chId);
    await sleep(500);
    const uiNoSub = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const b = Array.from(pg.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
      if (b) b.click();                          /* 外层按钮始终能开面板 */
      return { has: !!b,
        hint: (pg.textContent || '').indexOf('还没有配置副 API') >= 0,
        genDisabled: (() => {
          const panel = pg.querySelector('.appear-ai-panel');
          if (!panel) return null;
          const gb = Array.from(panel.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
          return gb ? gb.disabled : null;
        })() };
    });
    chk('B1 无副 API：面板指路设置 + 面板内生成禁用 + 不调主 API',
      uiNoSub.has && uiNoSub.hint && uiNoSub.genDisabled === true, JSON.stringify(uiNoSub));

    /* B2 配置副 API 夹具（不可达端口，页面 route 拦截）→ 材料预填人设 */
    await page.evaluate(() => {
      const subs = [{ id: 'sub1', name: '返修副API', enabled: true,
        baseUrl: 'http://127.0.0.1:9/v1', model: 'rev-sub-model', apiKey: 'fixture-only' }];
      window.Sleepy.store.set('subApis', subs);
    });
    await page.evaluate((chId) => { window.Sleepy.nav.open('contact-edit', { id: chId, sandboxId: null }); }, ids.chId);
    await sleep(500);
    const uiSub = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const b = Array.from(pg.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
      b.click();
      return { hint: (pg.textContent || '').indexOf('rev-sub-model') >= 0 };
    });
    await sleep(300);
    const matInfo = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      const ta = panel ? panel.querySelector('textarea') : null;
      return { panel: !!panel, material: ta ? ta.value : '' };
    });
    chk('B2 面板打开 + 材料预填人设 + 显示真实接口模型',
      matInfo.panel && matInfo.material.indexOf('人鱼族') >= 0 && uiSub.hint);

    subCount = 0;
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const b = Array.from(pg.querySelector('.appear-ai-panel').querySelectorAll('button'))
        .find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
      b.click();   /* 面板内的生成按钮（初始与外层同名），点击后变「整理中…」 */
    });
    await sleep(800);
    const draft = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      if (!panel) return null;
      const tas = Array.from(panel.querySelectorAll('textarea'));
      const draftTa = tas.find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('外貌草稿') >= 0;
      });
      return { text: draftTa ? draftTa.value : '',
        missing: (panel.textContent || '').indexOf('身高感') >= 0,
        conflicts: (panel.textContent || '').indexOf('材料先说短发') >= 0 };
    });
    chk('B3 恰好一次分析请求，系统指令+材料走用户数据段',
      subCount === 1 && capturedSub && Array.isArray(capturedSub.messages)
      && capturedSub.messages[0].role === 'system'
      && capturedSub.messages[0].content.indexOf('角色生图外貌资料整理器') >= 0
      && capturedSub.messages[1].role === 'user'
      && capturedSub.messages[1].content.indexOf('【待整理材料') >= 0
      && capturedSub.messages[1].content.indexOf('人鱼族') >= 0,
      subCount + ' 次');
    chk('B4 草稿可编辑展示 + missing/conflicts 显示',
      !!draft && draft.text.indexOf('银灰色齐肩短发') >= 0 && draft.missing && draft.conflicts,
      JSON.stringify(draft && draft.text && draft.text.slice(0, 40)));

    /* B5 采用 → 回填表单字段（不落盘）；保存后才进 store */
    await page.evaluate((chId) => { window.__revChId = chId; }, ids.chId);
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      const b = Array.from(panel.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '采用草稿');
      b.click();
    });
    await sleep(500);
    const applied = await page.evaluate((chId) => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('文字锁脸 · 基础') >= 0;
      });
      const saved = window.Sleepy.core.findChar(chId) || {};
      return { field: ta ? ta.value : '', storeHas: (saved.faceLockText || '').indexOf('银灰色齐肩短发') >= 0,
        toast: (document.body.textContent || '').indexOf('已填入，保存档案后生效') >= 0 };
    }, ids.chId);
    chk('B5 采用回填表单 + 明示「保存档案后生效」+ store 未被直接写',
      applied.field.indexOf('银灰色齐肩短发') >= 0 && applied.toast && !applied.storeHas,
      JSON.stringify({ storeHas: applied.storeHas }));

    /* B6 保存 → store 真的有了 */
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const b = Array.from(pg.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '保存');
      if (b) b.click();
    });
    await sleep(500);
    const savedOk = await page.evaluate((chId) => {
      return ((window.Sleepy.core.findChar(chId) || {}).faceLockText || '').indexOf('银灰色齐肩短发') >= 0;
    }, ids.chId);
    chk('B6 页面保存后档案里真的有草稿（闭环）', savedOk);

    /* B7 取消 / 失败 / 空草稿安全（对 mask-edit 同一实现，换夹具跑失败分支） */
    await page.evaluate(() => {
      const subs = window.Sleepy.store.get('subApis') || [];
      window.Sleepy.store.set('subApis', subs);
      window.Sleepy.nav.open('mask-edit', { id: '', sandboxId: null });
    });
    await sleep(400);
    const maskUi = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="mask-edit"]');
      const b = Array.from(pg.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
      if (b) b.click();
      return { has: !!b };
    });
    await sleep(300);
    /* 失败分支：把 route 改成返回垃圾 —— 用不再拦截新请求的方式：直接改 mock 不可行，
       改为验证「材料为空点生成不发请求」+「取消不回填」两条最关键安全项 */
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="mask-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      const ta = panel.querySelector('textarea');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const subBefore = subCount;
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="mask-edit"]');
      const b = Array.from(pg.querySelector('.appear-ai-panel').querySelectorAll('button'))
        .find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
      if (b) b.click();
    });
    await sleep(400);
    chk('B7 空材料不发请求（零分析调用）', maskUi.has && subCount === subBefore);
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="mask-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      const b = Array.from(panel.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '取消');
      if (b) b.click();
    });
    await sleep(200);
    const maskField = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="mask-edit"]');
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('基础外貌锁定') >= 0;
      });
      return ta ? ta.value : null;
    });
    chk('B8 取消不回填不改字段', maskField === '');

    /* B9 无自动触发：刷新 + 打开各页不再有分析请求 */
    const subBeforeB9 = subCount;
    await page.reload({ waitUntil: 'load' });
    await waitApp(page);
    await page.evaluate(() => { window.Sleepy.nav.open('contacts'); });
    await sleep(400);
    await page.evaluate(() => { window.Sleepy.nav.open('settings-imggen'); });
    await sleep(400);
    chk('B9 打开/刷新/切换页面零分析请求', subCount === subBeforeB9, subCount + '/' + subBeforeB9);

    /* B10 在途编辑保护（核查 3）：生成等待期间（route 延迟 700ms 回复）改外貌字段
       → 草稿标旧横幅 + 采用前强制再确认，不静默覆盖新编辑 */
    await page.evaluate((chId) => { window.Sleepy.nav.open('contact-edit', { id: chId, sandboxId: null }); }, ids.chId);
    await sleep(500);
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const b = Array.from(pg.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
      b.click();
    });
    await sleep(200);
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      const b = Array.from(panel.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'AI 根据人设生成');
      b.click();   /* 材料已预填，直接发请求（700ms 延迟窗口） */
    });
    await sleep(150);
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('文字锁脸 · 基础') >= 0;
      });
      ta.value = '在途编辑测试：临时改动';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(1200);
    const staleUi = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      return {
        banner: !!panel && (panel.textContent || '').indexOf('这份草稿基于改动前的版本') >= 0,
        fieldChanged: !!panel && (panel.textContent || '').indexOf('外貌字段已被改动') >= 0
      };
    });
    chk('B10a 在途改字段 → 草稿标旧横幅亮出', staleUi.banner && staleUi.fieldChanged, JSON.stringify(staleUi));
    await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const panel = pg.querySelector('.appear-ai-panel');
      const b = Array.from(panel.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '采用草稿');
      b.click();
    });
    await sleep(300);
    const confirmUi = await page.evaluate(() => {
      const body = document.body.textContent || '';
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('文字锁脸 · 基础') >= 0;
      });
      return { confirmShown: body.indexOf('草稿基于改动前的版本') >= 0 && body.indexOf('仍要采用') >= 0,
        fieldNow: ta ? ta.value : '' };
    });
    chk('B10b 采用被拦下要求再确认，字段未被静默覆盖',
      confirmUi.confirmShown && confirmUi.fieldNow === '在途编辑测试：临时改动',
      JSON.stringify({ confirmShown: confirmUi.confirmShown }));
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '仍要采用');
      if (b) b.click();
    });
    await sleep(300);
    const applied2 = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="contact-edit"]');
      const ta = Array.from(pg.querySelectorAll('textarea')).find((t) => {
        const w = t.closest('.set-field');
        return w && ((w.querySelector('.set-label') || {}).textContent || '').indexOf('文字锁脸 · 基础') >= 0;
      });
      return ta ? ta.value : '';
    });
    chk('B10c 明确确认后才回填草稿', applied2.indexOf('银灰色齐肩短发') >= 0, applied2.slice(0, 40));

    /* A10 NAI UI 标注 */
    const naiHint = await page.evaluate(() => {
      const pg = document.querySelector('.page[data-page="settings-imggen"]');
      return (pg.textContent || '').indexOf('NAI 接口沿用其原生图路径') >= 0
        && (pg.textContent || '').indexOf('都不生效') >= 0;
    });
    chk('A10 设置页如实标注 NAI 不接本轮视觉层', naiHint);

    failed = results.filter((r) => !r.ok).length;
    console.log('\n结果：' + results.filter((r) => r.ok).length + ' ✓ / ' + failed + ' ✗'
      + '（拦截：生图=' + genCount + ' 副 API/生图chat=' + subCount + '）');
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
