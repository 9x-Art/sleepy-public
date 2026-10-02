/* ============================================================
   scripts/browser-e2-nai-formal-test.js — NAI 正式编译器请求拦截检查
   ------------------------------------------------------------
   ⚠️ 口径：本机 headless Edge + 本地静态服务 + page.route 拦截，
   全程不调付费接口；夹具接口 baseUrl 用不可达的 127.0.0.1:9 双保险。
   验证（2026-10-02 NAI 施工单 §七）：
     N1 buildFormalNaiRequest 纯函数层：校验复用 / 人数聚合（单复数、
        未知性别不贡献不丢人）/ V3-V4 字段隔离 / debug 标注
     N2 V3 单人：身份标记进 input、extras 恰好一份、无 V4 字段、
        ucPreset=0、接口预设按现有契约消费（含空回填）
     N3 V3 双人：两位主体的独特标记都进 input（顺序描述、非绑定）
     N4 V4.5 单人/双人：char_captions 逐主体、顺序对应、负面只有 base、
        use_coords/use_order 显式、无 centers/legacy_uc
     N5 接口预设消费：自定义预设词不失效、出厂词不重复追加（词条去重）
     N6 拒绝边界：重复/人数不符/模型不支持/编译抛错 → 报错零请求、
        不出现 legacy 形态请求
     N7 custom 视觉层空/非空（V3 单人 / V4.5 双人）：自定义标记恰好一份、
        不回退也不混入 builtin 视觉词、身份/描述/extras/接口预设标记不丢、
        V4 input===base_caption 且 char_captions 不混全局标记；
        隔离夹具预设用独特标记词，模式和自定义文本 finally 恢复
   run:
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-e2-nai-formal-test.js
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

const PORT = process.env.E2_NAI_PORT || 5223;
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
  await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const S = window.Sleepy;
    return !!(S && S.nav && S.core && S.nav.open);
  }, { timeout: 15000 });
  await sleep(600);
  return errs;
}

/* 1×1 PNG（真字节，让成功链路走完 media.put） */
const PX_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/* 最小 stored zip（NAI 返回 zip 包，extractFirstFile 拆第一个条目） */
function zipOf(pngBuf) {
  const name = Buffer.from('img.png', 'utf8');
  const head = Buffer.alloc(30);
  head.write('PK\x03\x04', 0, 'binary');
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(0, 8);              /* stored */
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(0x21, 12);
  head.writeUInt32LE(0, 14);
  head.writeUInt32LE(pngBuf.length, 18); /* csize */
  head.writeUInt32LE(pngBuf.length, 22); /* usize */
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name, pngBuf]);
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  let naiCount = 0;
  let capturedNai = null;   /* 最近一次 NAI 请求体（JSON） */
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.route('**/ai/generate-image', async (route) => {
      naiCount++;
      try { capturedNai = JSON.parse(route.request().postData() || '{}'); } catch (e) { capturedNai = null; }
      await route.fulfill({ status: 200, contentType: 'application/zip',
        body: zipOf(Buffer.from(PX_PNG_B64, 'base64')) });
    });

    const errs = await waitApp(page);
    chk('N0 启动无 pageerror', errs.length === 0, errs.join(' | '));

    /* ---- 夹具：虚构角色 + 虚构接口（不写私人资料） ---- */
    await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      /* 清掉历史接口，测试态从零开始 */
      g.saveApis([]);
      const c = window.Sleepy.core.upsertChar({
        name: 'NAI夹具角色A', kind: 'main', gender: 'female', faceLockText: 'qzx银发标记A'
      });
      window.__naiChA = c.id;
    });

    /* 三个 NAI 接口：V3 默认预设 / V3 自定义预设 / V4.5 默认预设 */
    const apiV3 = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('nai');
      a.name = 'NAI-V3'; a.baseUrl = 'http://127.0.0.1:9'; a.model = 'nai-diffusion-3';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a]));
      return a.id;
    });
    const apiV3custom = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('nai');
      a.name = 'NAI-V3-自定义预设'; a.baseUrl = 'http://127.0.0.1:9'; a.model = 'nai-diffusion-3';
      a.apiKey = 'fixture-only';
      a.positivePreset = '{p}, qzx正预设标记Q';
      a.negativePreset = 'qzx负预设标记N, lowres, worst quality, jpeg artifacts';
      g.saveApis(g.listApis().concat([a]));
      return a.id;
    });
    const apiV4 = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const a = g.newApi('nai');
      a.name = 'NAI-V45'; a.baseUrl = 'http://127.0.0.1:9'; a.model = 'nai-diffusion-4-5-full';
      a.apiKey = 'fixture-only';
      g.saveApis(g.listApis().concat([a]));
      return a.id;
    });

    async function genWithApi(plan, apiRec, extras) {
      return page.evaluate(async (p) => {
        const r = await window.Sleepy.imggen.generate({ plan: p.plan, api: p.api, extras: p.extras });
        return { ok: r.ok, msg: r.error ? r.error.message : '' };
      }, { plan, api: apiRec, extras: extras || [] });
    }
    function mkSub(id, name, gender, faceText) {
      return { entityType: 'char', entityId: id, name: name, gender: gender, faceText: faceText };
    }

    /* ========== N1 纯函数层 ========== */
    const pfn = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const api = { kind: 'nai', model: 'nai-diffusion-3', positivePreset: '', negativePreset: '' };
      const out = {};
      /* 未知性别不贡献人数 tag、不丢主体 */
      const rU = g.buildFormalNaiRequest({ api: api,
        plan: { contentType: 'person', shot: 'auto',
          subjects: [{ entityType: 'char', entityId: 'u1', name: '未', gender: '', faceText: 'qzx未知标记U' },
            { entityType: 'char', entityId: 'f1', name: '女', gender: 'female', faceText: '' }],
          description: 'x' } });
      out.unknownDebug = rU.ok ? rU.debug : null;
      out.unknownInput = rU.ok ? rU.request.positive : '';
      /* 校验复用：重复主体拦截消息与 general 同源 */
      const rDup = g.buildFormalNaiRequest({ api: api,
        plan: { contentType: 'person', subjects: [
          { entityType: 'char', entityId: 'c1', name: '甲', gender: 'female', faceText: '' },
          { entityType: 'char', entityId: 'c1', name: '甲', gender: 'female', faceText: '' }],
          description: 'x' } });
      out.dupMsg = rDup.ok ? '' : rDup.error.message;
      /* 单复数聚合 */
      const rAgg = g.buildFormalNaiRequest({ api: api,
        plan: { contentType: 'person', subjects: [
          { entityType: 'char', entityId: 'a', name: 'A', gender: 'female', faceText: '' },
          { entityType: 'char', entityId: 'b', name: 'B', gender: 'female', faceText: '' },
          { entityType: 'char', entityId: 'c', name: 'C', gender: 'male', faceText: '' }],
          description: 'x' } });
      out.aggInput = rAgg.ok ? rAgg.request.positive : '';
      return out;
    });
    chk('N1 未知性别 debug 标 countCoverage=partial',
      pfn.unknownDebug && pfn.unknownDebug.countCoverage === 'partial', JSON.stringify(pfn.unknownDebug));
    chk('N1 未知性别不贡献人数 tag（无 1other/1girl 冒充）',
      pfn.unknownInput.indexOf('1girl') >= 0 && pfn.unknownInput.indexOf('1other') < 0
      && countOf(pfn.unknownInput, '1girl') === 1,
      pfn.unknownInput.slice(0, 120));
    chk('N1 未知性别不丢主体（标记进 V3 input）',
      pfn.unknownInput.indexOf('qzx未知标记U') >= 0, pfn.unknownInput.slice(0, 160));
    chk('N1 重复主体拦截消息与 general 同源（校验共用）',
      pfn.dupMsg === '画面主体重复了', pfn.dupMsg);
    chk('N1 人数聚合单复数：2女1男 → 2girls + 1boy',
      pfn.aggInput.indexOf('2girls') >= 0 && pfn.aggInput.indexOf('1boy') >= 0,
      pfn.aggInput.slice(0, 120));

    /* ========== N2 V3 单人（默认预设回填 + extras 一份 + 无 V4 字段） ========== */
    naiCount = 0; capturedNai = null;
    const r1 = await genWithApi(
      { sender: 'char', contentType: 'person', shot: 'full',
        subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A')],
        description: 'qzx场景描述X' },
      (await page.evaluate((id) => window.Sleepy.imggen.listApis().find((x) => x.id === id), apiV3)),
      ['qzx附加词条E']);
    chk('N2 V3 单人发出请求（zip 夹具成功落地）',
      naiCount === 1 && r1.ok === true, JSON.stringify({ ok: r1.ok, msg: r1.msg, naiCount }));
    chk('N2 input 含身份标记/描述/extras 各恰好一份',
      capturedNai && countOf(capturedNai.input, 'qzx银发标记A') === 1
      && countOf(capturedNai.input, 'qzx场景描述X') === 1
      && countOf(capturedNai.input, 'qzx附加词条E') === 1,
      capturedNai && capturedNai.input.slice(0, 160));
    chk('N2 input 含 1girl + full body 镜头',
      capturedNai.input.indexOf('1girl') >= 0 && capturedNai.input.indexOf('full body') >= 0,
      capturedNai.input.slice(0, 120));
    chk('N2 V3 请求不带 v4_prompt / v4_negative_prompt',
      !('v4_prompt' in capturedNai.parameters) && !('v4_negative_prompt' in capturedNai.parameters),
      JSON.stringify(Object.keys(capturedNai.parameters)));
    chk('N2 ucPreset 维持 0（选 C）',
      capturedNai.parameters.ucPreset === 0, String(capturedNai.parameters.ucPreset));
    chk('N2 质量词在 core 之后（{p} 在预设开头 → 替换后置尾）',
      capturedNai.input.indexOf('best quality') > capturedNai.input.indexOf('1girl'),
      capturedNai.input.slice(0, 160));
    chk('N2 预设为空串 → 现有契约回填出厂词（沿用，不改 legacy 空值行为）',
      capturedNai.parameters.negative_prompt.indexOf('very displeasing') >= 0,
      capturedNai.parameters.negative_prompt.slice(0, 120));

    /* ========== N3 V3 双人（两位主体标记都进 input） ========== */
    naiCount = 0; capturedNai = null;
    const r2 = await genWithApi(
      { sender: 'user', contentType: 'person', shot: 'auto',
        subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A'),
          mkSub('fx-b', '夹具男B', 'male', 'qzx蓝发标记B')],
        description: 'qzx双人场景Y' },
      (await page.evaluate((id) => window.Sleepy.imggen.listApis().find((x) => x.id === id), apiV3)));
    chk('N3 V3 双人发出请求', naiCount === 1 && r2.ok === true, JSON.stringify({ ok: r2.ok, msg: r2.msg }));
    chk('N3 两位主体的独特标记都进 input（各恰好一份）',
      capturedNai && countOf(capturedNai.input, 'qzx银发标记A') === 1
      && countOf(capturedNai.input, 'qzx蓝发标记B') === 1,
      capturedNai && capturedNai.input.slice(0, 200));
    chk('N3 人数聚合 1girl + 1boy',
      capturedNai.input.indexOf('1girl') >= 0 && capturedNai.input.indexOf('1boy') >= 0,
      capturedNai.input.slice(0, 120));

    /* ========== N4 V4.5 char_captions ========== */
    naiCount = 0; capturedNai = null;
    const r3 = await genWithApi(
      { sender: 'user', contentType: 'person', shot: 'auto',
        subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A'),
          mkSub('fx-b', '夹具男B', 'male', 'qzx蓝发标记B')],
        description: 'qzx双人场景Z' },
      (await page.evaluate((id) => window.Sleepy.imggen.listApis().find((x) => x.id === id), apiV4)),
      ['qzx附加词条E']);
    chk('N4 V4.5 双人发出请求', naiCount === 1 && r3.ok === true, JSON.stringify({ ok: r3.ok, msg: r3.msg }));
    const vp = capturedNai && capturedNai.parameters.v4_prompt;
    const vn = capturedNai && capturedNai.parameters.v4_negative_prompt;
    chk('N4 v4_prompt 存在且 base_caption 与 input 同值',
      vp && vp.caption.base_caption === capturedNai.input,
      vp && vp.caption.base_caption.slice(0, 120));
    chk('N4 char_captions 恰好两档、顺序对应 A→B',
      vp && vp.caption.char_captions.length === 2
      && vp.caption.char_captions[0].char_caption.indexOf('qzx银发标记A') >= 0
      && vp.caption.char_captions[1].char_caption.indexOf('qzx蓝发标记B') >= 0,
      JSON.stringify(vp && vp.caption.char_captions));
    chk('N4 char_captions 用不带数字的 girl/boy（防人数 tag 双份）',
      vp && vp.caption.char_captions.every((c) =>
        c.char_caption.indexOf('1girl') < 0 && c.char_caption.indexOf('1boy') < 0
        && (c.char_caption.indexOf('girl') >= 0 || c.char_caption.indexOf('boy') >= 0)),
      JSON.stringify(vp && vp.caption.char_captions));
    chk('N4 use_coords=false / use_order=true 显式、无 centers / legacy_uc',
      vp && vp.use_coords === false && vp.use_order === true
      && !('legacy_uc' in vp)
      && vp.caption.char_captions.every((c) => !('centers' in c)),
      JSON.stringify(Object.keys(vp || {})));
    chk('N4 v4_negative_prompt：base 与 negative 同值、char_captions 空',
      vn && vn.caption.base_caption === capturedNai.parameters.negative_prompt
      && vn.caption.char_captions.length === 0,
      JSON.stringify(vn && Object.keys(vn)));
    chk('N4 extras 恰好一份（base 里，不在 char_caption 重复）',
      countOf(capturedNai.input, 'qzx附加词条E') === 1
      && vp.caption.char_captions.every((c) => c.char_caption.indexOf('qzx附加词条E') < 0),
      capturedNai.input.slice(-120));

    /* ========== N5 接口预设消费（自定义不失效 + 出厂词不重复） ========== */
    naiCount = 0; capturedNai = null;
    const r4 = await genWithApi(
      { sender: 'char', contentType: 'person', shot: 'auto',
        subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A')],
        description: 'qzx预设消费场景', extras: [] },
      (await page.evaluate((id) => window.Sleepy.imggen.listApis().find((x) => x.id === id), apiV3custom)));
    chk('N5 自定义预设请求发出', naiCount === 1 && r4.ok === true, JSON.stringify({ ok: r4.ok, msg: r4.msg }));
    chk('N5 自定义正预设词进 input（{p} 替换后置尾）、负预设词进 negative',
      capturedNai.input.indexOf('qzx正预设标记Q') >= 0
      && capturedNai.parameters.negative_prompt.indexOf('qzx负预设标记N') >= 0,
      JSON.stringify({ input: capturedNai.input.slice(-80), neg: capturedNai.parameters.negative_prompt.slice(0, 120) }));
    chk('N5 lowres / worst quality 各恰好一份（预设与结构负面词条去重）',
      countOf(capturedNai.parameters.negative_prompt, 'lowres') === 1
      && countOf(capturedNai.parameters.negative_prompt, 'worst quality') === 1,
      capturedNai.parameters.negative_prompt.slice(0, 160));
    /* 出厂词不双份：默认预设接口的 negative 里 watermark 在预设与结构负面都有 → 去重成一份 */
    naiCount = 0; capturedNai = null;
    await genWithApi(
      { sender: 'char', contentType: 'person', shot: 'auto',
        subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A')],
        description: 'qzx去重检查', extras: [] },
      (await page.evaluate((id) => window.Sleepy.imggen.listApis().find((x) => x.id === id), apiV3)));
    chk('N5 出厂预设词不重复追加（watermark / lowres 各一份）',
      countOf(capturedNai.parameters.negative_prompt, 'watermark') === 1
      && countOf(capturedNai.parameters.negative_prompt, 'lowres') === 1,
      capturedNai.parameters.negative_prompt.slice(0, 200));

    /* ========== N6 拒绝边界：报错零请求、不回落 legacy ========== */
    const rejectPlans = [
      { name: 'N6a 重复主体', plan: { contentType: 'person', subjects: [
        mkSub('fx-a', 'A', 'female', ''), mkSub('fx-a', 'A', 'female', '')], description: 'x' } },
      { name: 'N6b 声明2解析1', plan: { contentType: 'person', subjects: [
        mkSub('fx-a', 'A', 'female', '')], description: 'x', expectedSubjectCount: 2 } },
      { name: 'N6c 超4人', plan: { contentType: 'person', subjects: [
        mkSub('a', '', 'female', ''), mkSub('b', '', 'female', ''), mkSub('c', '', 'female', ''),
        mkSub('d', '', 'female', ''), mkSub('e', '', 'female', '')], description: 'x' } },
      { name: 'N6d 0人报person', plan: { contentType: 'person', subjects: [], description: 'x' } }
    ];
    for (const t of rejectPlans) {
      naiCount = 0; capturedNai = null;
      const r = await genWithApi(t.plan,
        (await page.evaluate((id) => window.Sleepy.imggen.listApis().find((x) => x.id === id), apiV3)));
      chk(t.name + ' → 报错零请求', r.ok === false && naiCount === 0,
        JSON.stringify({ ok: r.ok, msg: r.msg, naiCount }));
    }
    /* 模型不支持（不在 NAI_MODELS） */
    naiCount = 0; capturedNai = null;
    const badModelApi = await page.evaluate(() => {
      const a = window.Sleepy.imggen.newApi('nai');
      a.name = 'NAI-坏模型'; a.baseUrl = 'http://127.0.0.1:9'; a.model = 'nai-unknown-model';
      a.apiKey = 'fixture-only';
      return a;
    });
    const rBad = await genWithApi({ contentType: 'person',
      subjects: [mkSub('fx-a', 'A', 'female', '')], description: 'x' }, badModelApi);
    chk('N6e 模型不支持 → 报错零请求（不回落）',
      rBad.ok === false && naiCount === 0 && rBad.msg.indexOf('模型') >= 0,
      JSON.stringify({ ok: rBad.ok, msg: rBad.msg, naiCount }));
    /* 模型未配置（空） */
    naiCount = 0;
    const emptyModelApi = await page.evaluate(() => {
      const a = window.Sleepy.imggen.newApi('nai');
      a.name = 'NAI-空模型'; a.baseUrl = 'http://127.0.0.1:9'; a.model = '';
      a.apiKey = 'fixture-only';
      return a;
    });
    const rEmpty = await genWithApi({ contentType: 'person',
      subjects: [mkSub('fx-a', 'A', 'female', '')], description: 'x' }, emptyModelApi);
    chk('N6f 模型未配置 → 报错零请求（不回落）',
      rEmpty.ok === false && naiCount === 0, JSON.stringify({ ok: rEmpty.ok, msg: rEmpty.msg }));
    /* 编译直接抛错（getter 夹具）：generate 的 try/catch 兜住，零请求 */
    naiCount = 0; capturedNai = null;
    const rThrow = await page.evaluate(async () => {
      const bad = { kind: 'nai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k',
        positivePreset: '', negativePreset: '' };
      Object.defineProperty(bad, 'model', { get() { throw new Error('qzx抛错夹具'); } });
      const r = await window.Sleepy.imggen.generate({
        plan: { contentType: 'person', subjects: [
          { entityType: 'char', entityId: 'a', name: 'A', gender: 'female', faceText: '' }],
          description: 'x' },
        api: bad });
      return { ok: r.ok, msg: r.error ? r.error.message : '', detail: r.error ? r.error.detail : '' };
    });
    chk('N6g 编译抛错 → 明确报错零请求（不回落 legacy）',
      rThrow.ok === false && naiCount === 0
      && rThrow.msg.indexOf('编译失败') >= 0 && rThrow.detail.indexOf('qzx抛错夹具') >= 0,
      JSON.stringify(rThrow));

    /* ========== N7 custom 视觉层空/非空（隔离夹具 + 配置恢复） ==========
       隔离口径：正负面预设全部换成独特标记词（不与 builtin 视觉词重合，
       正向保留 {p} 占位契约），出厂词回填不会触发 → builtin 视觉词
       （detailed face / natural skin texture / soft lighting / detailed background）
       一旦出现即判定为混入。模式和自定义文本在 finally 恢复，不碰真实用户配置。 */
    const prevStyle = await page.evaluate(() => {
      const g = window.Sleepy.imggen;
      const prev = { mode: g.imgStyleMode(), custom: g.imgStyleCustom() };
      g.saveApis(g.listApis().concat([
        Object.assign(g.newApi('nai'),
          { name: 'NAI-V3-隔离预设', baseUrl: 'http://127.0.0.1:9', model: 'nai-diffusion-3',
            apiKey: 'fixture-only',
            positivePreset: '{p}, qzx正预设质量标记Q', negativePreset: 'qzx负预设标记N, lowres' }),
        Object.assign(g.newApi('nai'),
          { name: 'NAI-V45-隔离预设', baseUrl: 'http://127.0.0.1:9', model: 'nai-diffusion-4-5-full',
            apiKey: 'fixture-only',
            positivePreset: '{p}, qzx正预设质量标记Q', negativePreset: 'qzx负预设标记N, lowres' })
      ]));
      return prev;
    });
    try {
      const BUILTIN_VISUAL_WORDS = ['detailed face', 'natural skin texture', 'soft lighting', 'detailed background'];
      const apiV3m = await page.evaluate(() =>
        window.Sleepy.imggen.listApis().find((x) => x.name === 'NAI-V3-隔离预设'));
      const apiV4m = await page.evaluate(() =>
        window.Sleepy.imggen.listApis().find((x) => x.name === 'NAI-V45-隔离预设'));
      await page.evaluate(() => {
        const g = window.Sleepy.imggen;
        g.setImgStyleMode('custom');
        g.setImgStyleCustom('qzx自定义视觉标记C');
      });

      /* N7a · V3 单人 × custom 非空 */
      naiCount = 0; capturedNai = null;
      const rA = await genWithApi(
        { sender: 'char', contentType: 'person', shot: 'full',
          subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A')],
          description: 'qzx场景描述C1' },
        apiV3m, ['qzx附加词条C']);
      chk('N7a V3 单人 custom 非空：请求发出',
        naiCount === 1 && rA.ok === true, JSON.stringify({ ok: rA.ok, msg: rA.msg }));
      chk('N7a 自定义标记恰好一份进 base',
        countOf(capturedNai.input, 'qzx自定义视觉标记C') === 1,
        capturedNai.input.slice(0, 160));
      chk('N7a 无 builtin 视觉层特征词混入',
        BUILTIN_VISUAL_WORDS.every((w) => capturedNai.input.indexOf(w) < 0),
        capturedNai.input.slice(0, 200));
      chk('N7a 接口预设标记仍在 + 身份/描述/extras 不丢',
        capturedNai.input.indexOf('qzx正预设质量标记Q') >= 0
        && capturedNai.parameters.negative_prompt.indexOf('qzx负预设标记N') >= 0
        && countOf(capturedNai.input, 'qzx银发标记A') === 1
        && countOf(capturedNai.input, 'qzx场景描述C1') === 1
        && countOf(capturedNai.input, 'qzx附加词条C') === 1,
        capturedNai.input.slice(0, 220));
      chk('N7a V3 保留身份且不发 V4 字段',
        capturedNai.input.indexOf('1girl') >= 0
        && !('v4_prompt' in capturedNai.parameters)
        && !('v4_negative_prompt' in capturedNai.parameters),
        JSON.stringify(Object.keys(capturedNai.parameters)));

      /* N7b · V3 单人 × custom 空（不回退 builtin） */
      await page.evaluate(() => { window.Sleepy.imggen.setImgStyleCustom(''); });
      naiCount = 0; capturedNai = null;
      const rB = await genWithApi(
        { sender: 'char', contentType: 'person', shot: 'full',
          subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A')],
          description: 'qzx场景描述C2' },
        apiV3m, ['qzx附加词条C']);
      chk('N7b V3 单人 custom 空：请求发出',
        naiCount === 1 && rB.ok === true, JSON.stringify({ ok: rB.ok, msg: rB.msg }));
      chk('N7b 不回退 builtin 视觉层（特征词全部缺席）',
        BUILTIN_VISUAL_WORDS.every((w) => capturedNai.input.indexOf(w) < 0),
        capturedNai.input.slice(0, 200));
      chk('N7b 无 custom 标记 + 身份/描述/extras/预设标记仍在',
        capturedNai.input.indexOf('qzx自定义视觉标记C') < 0
        && countOf(capturedNai.input, 'qzx银发标记A') === 1
        && countOf(capturedNai.input, 'qzx场景描述C2') === 1
        && countOf(capturedNai.input, 'qzx附加词条C') === 1
        && capturedNai.input.indexOf('qzx正预设质量标记Q') >= 0
        && capturedNai.parameters.negative_prompt.indexOf('qzx负预设标记N') >= 0,
        capturedNai.input.slice(0, 220));

      /* N7c · V4.5 双人 × custom 非空 */
      await page.evaluate(() => { window.Sleepy.imggen.setImgStyleCustom('qzx自定义视觉标记C'); });
      naiCount = 0; capturedNai = null;
      const rC = await genWithApi(
        { sender: 'user', contentType: 'person', shot: 'auto',
          subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A'),
            mkSub('fx-b', '夹具男B', 'male', 'qzx蓝发标记B')],
          description: 'qzx双人场景C3' },
        apiV4m, ['qzx附加词条C']);
      const vpC = capturedNai && capturedNai.parameters.v4_prompt;
      chk('N7c V4.5 双人 custom 非空：请求发出',
        naiCount === 1 && rC.ok === true, JSON.stringify({ ok: rC.ok, msg: rC.msg }));
      chk('N7c input 与 base_caption 同值；自定义标记恰好一份在 base',
        vpC && vpC.caption.base_caption === capturedNai.input
        && countOf(capturedNai.input, 'qzx自定义视觉标记C') === 1,
        capturedNai && capturedNai.input.slice(0, 180));
      chk('N7c 人物独立字段不混入全局 custom 标记、各自身份在位',
        vpC && vpC.caption.char_captions.length === 2
        && vpC.caption.char_captions.every((c) => c.char_caption.indexOf('qzx自定义视觉标记C') < 0)
        && vpC.caption.char_captions[0].char_caption.indexOf('qzx银发标记A') >= 0
        && vpC.caption.char_captions[1].char_caption.indexOf('qzx蓝发标记B') >= 0,
        JSON.stringify(vpC && vpC.caption.char_captions));
      chk('N7c 无 builtin 视觉层特征词混入（base 与 char_captions 双查）',
        BUILTIN_VISUAL_WORDS.every((w) => capturedNai.input.indexOf(w) < 0)
        && vpC.caption.char_captions.every((c) =>
          BUILTIN_VISUAL_WORDS.every((w2) => c.char_caption.indexOf(w2) < 0)),
        capturedNai.input.slice(0, 200));

      /* N7d · V4.5 双人 × custom 空 */
      await page.evaluate(() => { window.Sleepy.imggen.setImgStyleCustom(''); });
      naiCount = 0; capturedNai = null;
      const rD = await genWithApi(
        { sender: 'user', contentType: 'person', shot: 'auto',
          subjects: [mkSub('fx-a', 'NAI夹具角色A', 'female', 'qzx银发标记A'),
            mkSub('fx-b', '夹具男B', 'male', 'qzx蓝发标记B')],
          description: 'qzx双人场景C4' },
        apiV4m, ['qzx附加词条C']);
      const vpD = capturedNai && capturedNai.parameters.v4_prompt;
      chk('N7d V4.5 双人 custom 空：请求发出且不回退 builtin 视觉层',
        naiCount === 1 && rD.ok === true && vpD
        && BUILTIN_VISUAL_WORDS.every((w) => capturedNai.input.indexOf(w) < 0),
        JSON.stringify({ ok: rD.ok, msg: rD.msg, input: capturedNai && capturedNai.input.slice(0, 200) }));
      chk('N7d 无 custom 标记；身份在 char_captions、人数/描述/预设标记在 base',
        capturedNai.input.indexOf('qzx自定义视觉标记C') < 0
        && countOf(capturedNai.input, '1girl') === 1 && countOf(capturedNai.input, '1boy') === 1
        && countOf(capturedNai.input, 'qzx双人场景C4') === 1
        && capturedNai.input.indexOf('qzx正预设质量标记Q') >= 0
        && vpD.caption.char_captions[0].char_caption.indexOf('qzx银发标记A') >= 0
        && vpD.caption.char_captions[1].char_caption.indexOf('qzx蓝发标记B') >= 0,
        JSON.stringify(vpD && vpD.caption.char_captions));
    } finally {
      await page.evaluate((p) => {
        const g = window.Sleepy.imggen;
        g.setImgStyleMode(p.mode);
        g.setImgStyleCustom(p.custom);
      }, prevStyle);
    }

    /* ========== 汇总 ========== */
    const failed = results.filter((r) => !r.ok).length;
    console.log('\n结果：' + results.filter((r) => r.ok).length + ' ✓ / ' + failed + ' ✗'
      + '（NAI 拦截总数 ' + naiCount + '）');
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
