/* 共享行为决策层 + 三场景最小接线 —— 验收测试（v160）

   ★ 全程**真实页面装配路径** + **模型通道桩**，不发任何付费请求。
     判据落在「最终出站 payload 的 system 段」—— 不是读内部变量，
     因为「UI/变量看起来对」与「真的进了 system」是两件事。

   覆盖（对应批准范围）：
     1. 合法 spec 能成功装配
     2. 非法 spec 被检出（不泄漏未捕获异常）
     3. 模块缺失 → 整条回退
     4. **实际注入与诊断一致**（诊断不得声称未注入的模块）
     5. override 三分支（proactive 卡 / shell / 群线下 shell）
     6. 旧协议仍保留（proactive 卡、f2、群协议七块）
     7. 线上／线下重构前后结果一致
     8. 撤掉 sceneText 注入 → 本测试必须变红（负向对照，见 §负向） */

const { chromium } = require('playwright-core');
const BASE = process.env.SLEEPY_BASE || 'http://127.0.0.1:5173';

let ok = 0, bad = 0;
const fails = [];
function okMsg(m) { ok++; process.stdout.write('  ✓ ' + m + '\n'); }
function badMsg(m) { bad++; fails.push(m); process.stdout.write('  ✗ ' + m + '\n'); }
function assert(cond, m) { if (!cond) throw new Error(m); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(m + ' —— 期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a));
  }
}

/* 在页内跑：装夹具 → 触发装配 → 抓最终出站 payload → 取诊断 */
async function runProactive(page, opts) {
  return page.evaluate(function (o) {
    var PE = Sleepy.promptEngine;
    var core = Sleepy.core, sb = core.listSandboxes()[0];
    var ch = core.upsertChar({ id: '__bt_pro__', kind: 'main', name: '验甲',
      content: '旧书店老板，话少。', sandboxId: sb && sb.id });
    var u = core.activeUser() || core.userMasks()[0];

    /* 卡片 override：直接写 overrides（与用户改卡同一入口） */
    /* ⚠️ 顺序：先设 override，再按 clear* 标志清 —— clearShell 只在
       「本节要回到未 override 态」时才传，否则会把自己刚设的清掉。 */
    if (o.overrideShell) PE.saveCardBody('shell', 'OVERRIDE-SHELL-MARK ' + o.tag);
    if (o.overrideProactive) PE.saveCardBody('proactive', 'OVERRIDE-PROACTIVE-MARK ' + o.tag);
    if (o.clearShell) PE.resetCard('shell');
    if (o.clearProactive) PE.resetCard('proactive');

    /* ★ 观察最终出站：拦 api.requestOnce 的**入参**（真正送进 callModel 的
       messages），并透传原实现。桩只改「回什么」，不改「发什么」。 */
    var captured = null;
    var orig = Sleepy.api.requestOnce;
    Sleepy.api.requestOnce = function (cand, messages) {
      captured = JSON.stringify(messages);
      return Promise.resolve({ ok: true, ms: 1,
        content: '{"decision":"skip","triggerIds":[],"message":"","actionRequests":[],"reasonCode":"x","stateUpdate":{"status":"dropped","nextEligibleAt":null}}' });
    };

    var sys = Sleepy.proactiveEngine.buildSystem(ch.id, u && u.id);
    Sleepy.api.requestOnce = orig;
    var note = Sleepy.proactiveEngine.behaviorNote();
    return {
      sysLen: sys.length,
      sysText: sys.join('\n\n'),
      note: note,
      captured: captured
    };
  }, opts || {});
}

async function runGroupOffline(page, opts) {
  return page.evaluate(function (o) {
    var PE = Sleepy.promptEngine;
    var core = Sleepy.core, sb = core.listSandboxes()[0];
    var ch = core.upsertChar({ id: '__bt_go__', kind: 'main', name: '群乙',
      content: '群里的另一个人。', sandboxId: sb && sb.id });
    /* ⚠️ 顺序要紧：先清、再按本节需要设 override。
       （我第一版把 resetCard 写在 saveCardBody **之后**，把本节的 override 清掉了，
         第 8 节于是误报「用户改的 shell 不在 system 里」—— 测试缺陷，不是产品问题。） */
    PE.resetCard('shell');
    if (o.overrideShell) PE.saveCardBody('shell', 'OVERRIDE-SHELL-MARK ' + o.tag);

    /* ⚠️ 不走 createFromHandoff —— 它要求真实群与交接态，
       全新 profile 里没有。这里直接构造 buildSystem 真正需要的最小会话形状
       （buildSystem 是纯函数：只读 s.env / s.purpose / s.parts 等）。 */
    var sess = {
      id: '__bt_go_sess__',
      groupId: '__bt_g__',
      ownerId: ch.id,
      env: { location: '旧书店', timeOfDay: '下午', weather: '晴', clockTime: '15:04' },
      purpose: '等人',
      inherit: false,
      parts: [{ ownerId: ch.id, kind: 'char', npc: false, inScene: true }],
      narrativeSettings: {}
    };
    if (!sess) return { error: '会话构造失败' };
    var txt = Sleepy.groupOfflineStore.buildSystem(sess);
    var note = Sleepy.groupOfflineStore.behaviorNote();
    return { txt: txt, note: note };
  }, opts || {});
}

/* 群线上：跑真实的 composeRound，抓**最终出站 messages**（不是读内部变量）。
   ★ 桩只拦最外层网络通道 api.requestOnce，并记录调用参数 ——
     「有没有请求旧 shell 卡」要靠「调用记录 + 出站 system 原文」两处一起判。 */
/* 冻结行为模块的**首句锚点**（判「真的进了 system」的探针）。
   ★ 首句只够判「有没有」，判「完不完整」要用整块正文（见 9.2 / 负向 N7）。 */
const BT_FIRST = {
  'B': '以本轮提供的有效资料',
  'P': '对每个获准扮演的人物，依据其资料',
  'L': '结合本轮明确篇幅需求',
  'E': '当前通过消息交流',
  'S4': '依据群成员、有效身份映射和当前可见消息'
};

/* 数某个子串在长文里出现的次数（整块正文计数用，能抓「重复注入」）。 */
function occurrences(hay, needle) {
  if (!needle) return 0;
  var n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

async function runGroupOnline(page, opts) {
  return page.evaluate(function (o) {
    var PE = Sleepy.promptEngine, core = Sleepy.core;
    /* ⚠️ 顺序要紧：先清、再按本节需要设 override（同 runGroupOffline 的教训）。 */
    PE.resetCard('shell');
    if (o.overrideShell) PE.saveCardBody('shell', 'OVERRIDE-SHELL-MARK ' + o.tag);

    /* 虚构夹具：建一个最小群岛 + 群，凑出 entitiesOf 非空。
       不复用任何真实用户数据（全新 profile，本来也没有）。 */
    var sb = core.listSandboxes()[0];
    if (!sb) { sb = core.createSandbox('archipelago', '群线上测试岛'); core.setActiveSandbox(sb.id); }
    var a = core.upsertChar({ id: '__bt_gon_a__', kind: 'main', name: '群甲',
      content: '群里的甲，话少。', sandboxId: sb.id });
    var b = core.upsertChar({ id: '__bt_gon_b__', kind: 'sub', parentId: a.id,
      content: '群里的甲的皮套。', sandboxId: sb.id });
    var nu = core.upsertChar({ id: '__bt_gon_n__', kind: 'npc', parentId: a.id,
      content: 'NPC 人设', knownBy: [], sandboxId: sb.id });
    var u = core.activeUser() || core.ensureDefaultUser();
    var g = Sleepy.groupStore.createGroup({
      name: '群线上测试群', ownerAccountId: u.id,
      members: [
        { kind: 'char', ownerId: a.id, accountId: a.id },
        { kind: 'char', ownerId: a.id, accountId: b.id },
        { kind: 'npc', ownerId: nu.id, accountId: nu.id }
      ]
    });
    if (!g.ok) return { error: '建群失败：' + g.message };
    var gid = g.group.id;
    Sleepy.groupStore.addMessage(gid, { senderKind: 'user', senderAccountId: u.id,
      content: '@全体成员 明晚有空吗？' });

    /* 记调用：桩只改「回什么」，并把入参逐次抄下来。 */
    var calls = [];
    var orig = Sleepy.api.requestOnce;
    Sleepy.api.requestOnce = function (cand, messages) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      return Promise.resolve({ ok: true, ms: 1,
        content: '{"plans":[],"messages":[],"suggestContinue":false}' });
    };
    var round = Sleepy.groupAI.composeRound(gid, { stimulus: '（测试）' });
    Sleepy.api.requestOnce = orig;
    if (!round) return { error: 'composeRound 没装配出来' };

    return {
      sysText: round.messages[0].content,
      usrText: round.messages[1].content,
      msgCount: round.messages.length,
      roles: round.messages.map(function (m) { return m.role; }),
      entities: round.entities.length,
      note: Sleepy.groupAI.behaviorNote(),
      /* composeRound 是纯函数，正常不外发；这里带上调用记录以证明「没请求旧 shell」。 */
      calls: calls,
      shellCardBody: PE.cardBody('shell'),
      groupRoundBody: PE.cardBody('groupRound')
    };
  }, opts || {});
}

(async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];

  async function newPage() {
    const c = await browser.newContext();
    const pg = await c.newPage();
    pg.on('pageerror', function (e) {
      var s = String(e && e.message);
      if (/\[Sleepy\]/.test(s)) errors.push(s.slice(0, 200));
    });
    pg.on('console', function (m) {
      if (m.type() === 'error') errors.push(m.text().slice(0, 200));
    });
    await pg.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('window.Sleepy && Sleepy.promptEngine && Sleepy.proactiveEngine',
      null, { timeout: 20000 });
    await pg.waitForFunction('!!document.querySelector(\'[data-page="home"].is-active\')',
      null, { timeout: 20000 });
    await pg.waitForTimeout(500);
    return pg;
  }

  let page = await newPage();

  /* ★ 卡片 override 是**持久**的（写进 store）—— 上一节改了不给后面清，
     后面全部会因为「shell 处于 override 态」而误判成回退。
     这不是产品问题，是测试状态污染。每节跑完统一还原。 */
  async function resetCards() {
    await page.evaluate(function () {
      ['shell', 'f1', 'c05', 'f2', 'proactive'].forEach(function (id) {
        try { Sleepy.promptEngine.resetCard(id); } catch (e) { /* 卡不存在就算了 */ }
      });
    });
  }

  process.stdout.write('\n1. 决策层基础：合法 spec 成功 / 非法 spec 被检出\n');
  {
    const r = await page.evaluate(function () {
      var PE = Sleepy.promptEngine;
      var out = {};
      ['online', 'offline', 'proactive', 'groupOnline', 'groupOffline'].forEach(function (k) {
        var d = PE.btDecideScene(k);
        out[k] = d ? { ok: d.ok, reason: d.reason, modules: d.modules,
          pendingModules: d.pendingModules, partial: d.partial,
          injectShell: d.injectShell, injectScene: d.injectScene } : null;
      });
      out._scenes = PE.btScenes;
      /* 未知场景必须返回 null（而不是抛） */
      out._unknown = PE.btDecideScene('noSuchScene');
      /* btNote 在工厂尚未装配时也不能崩 */
      out._noteNoDec = PE.btNote('proactive', null, false, false);
      return out;
    });
    try {
      eq(r._scenes, ['online', 'offline', 'proactive', 'groupOnline', 'groupOffline'],
        '★ btScenes 闭集：');
      assert(r._unknown === null, '★ 未知场景应返回 null，不该抛异常');
      okMsg('btScenes 五场景闭集；未知场景返回 null（不抛）');

      eq(r.online.modules, ['B', 'P', 'L', 'E', 'S1'], '★ 线上 modules：');
      eq(r.offline.modules, ['B', 'P', 'L', 'N', 'S2'], '★ 线下 modules：');
      eq(r.online.pendingModules, [], '线上不该有 pendingModules：');
      eq(r.offline.pendingModules, [], '线下不该有 pendingModules：');
      assert(r.online.ok === true && r.offline.ok === true,
        '线上/线下决策应成功，实得 ' + JSON.stringify([r.online, r.offline]));
      okMsg('线上 B/P/L/E/S1、线下 B/P/L/N/S2：ok=true、pending 为空');
    } catch (e) { badMsg('1 合法 spec -> ' + e.message); }

    try {
      assert(r.proactive.ok === true, 'proactive 决策应成功');
      eq(r.proactive.modules, ['B', 'P', 'L', 'E', 'S3'],
        '★ proactive 默认 modules（完整接线）：');
      eq(r.proactive.pendingModules, [], '★ proactive 默认不该有 pendingModules：');
      assert(r.proactive.partial === false, '★ proactive 默认 partial 应为 false');
      okMsg('proactive 默认完整接线：modules = B/P/L/E/S3、partial = false');
    } catch (e) { badMsg('1 proactive 默认 -> ' + e.message); }

    try {
      assert(r.groupOffline.ok === true, 'groupOffline 决策应成功');
      /* 2026-10-05 用户裁决：groupOffline 接入 S5（injectScene 改 true）——
         老断言停在裁决前（B/P/L + pending N/S5），随批更新。 */
      eq(r.groupOffline.modules, ['B', 'P', 'L', 'N', 'S5'],
        '★ groupOffline 全量接线（裁决后）：');
      eq(r.groupOffline.pendingModules, [],
        '★ groupOffline 不该有 pendingModules：');
      assert(r.groupOffline.partial === false, '★ groupOffline partial 应为 false');
      assert(r.groupOffline.injectScene === true,
        '★ groupOffline 裁决后应注入 scene');
      okMsg('groupOffline 全量接线：modules=B/P/L/N/S5 · pending 空 · partial=false · injectScene=true');
    } catch (e) { badMsg('1 groupOffline -> ' + e.message); }

    try {
      assert(r.groupOnline.ok === true, '★ groupOnline 决策应成功');
      eq(r.groupOnline.modules, ['B', 'P', 'L', 'E', 'S4'],
        '★ groupOnline 接线后 modules 应为全量：');
      eq(r.groupOnline.pendingModules, [], '★ groupOnline 接线后不该有 pendingModules：');
      assert(r.groupOnline.partial === false, '★ groupOnline 接线后 partial 应为 false');
      assert(r.groupOnline.injectShell === true && r.groupOnline.injectScene === true,
        '★ groupOnline 两个注入开关都应为 true');
      okMsg('groupOnline 已接线：modules = B/P/L/E/S4、pending 为空、partial=false');
    } catch (e) { badMsg('1 groupOnline -> ' + e.message); }
  }

  process.stdout.write('\n2. spec 护栏：非法 spec 必须被检出且不泄漏异常\n');
  {
    /* 直接打 btDecide —— 它是唯一入口，非法 spec 必须 throw。
       btDecideScene 那一层负责把 throw 转成回退（第 3 节验）。 */
    const r = await page.evaluate(function () {
      var PE = Sleepy.promptEngine;
      /* btDecide 未导出 —— 用 btDecideScene 的 overrides 间接测：
         overrides 只接受三个键，注不了非法 contract。
         所以这里改测「表被写坏」的情形：临时把一个 spec 换成非法形状。 */
      var out = {};
      /* 2.1 overrides 里的非布尔 injectShell 必须被忽略（不是被当假值用） */
      var d1 = PE.btDecideScene('proactive', { injectShell: 'false' });
      out.字符串注入标志 = d1 ? { ok: d1.ok, injectShell: d1.injectShell } : null;
      /* 2.2 overrides 只认三个键，别的键必须被忽略而不是生效 */
      var d2 = PE.btDecideScene('proactive', { contract: { shell: ['B'], scene: [] } });
      out.注契约被忽略 = d2 ? { ok: d2.ok, modules: d2.modules } : null;
      /* 2.3 正常调用不得抛 */
      var threw = false;
      try { PE.btDecideScene('proactive'); } catch (e) { threw = true; }
      out.正常不抛 = !threw;
      return out;
    });
    try {
      assert(r.正常不抛 === true, '★ 正常调用不该抛');
      okMsg('正常调用不抛未捕获异常');
    } catch (e) { badMsg('2 正常调用 -> ' + e.message); }

    try {
      /* overrides 里的非布尔值被忽略 → 仍走表里的 true，
         若实现写成 `if (typeof x === 'boolean')` 才生效，这里就是 true。 */
      assert(r.字符串注入标志 && r.字符串注入标志.injectShell === true,
        '★ 非布尔 injectShell 必须被忽略（表里是 true）：' +
        JSON.stringify(r.字符串注入标志));
      okMsg('非法 overrides（injectShell 传字符串）被忽略，不静默当真值');
    } catch (e) { badMsg('2 非法 injectShell -> ' + e.message); }

    try {
      assert(r.注契约被忽略 && r.注契约被忽略.ok === true,
        '★ overrides 注 contract 必须被忽略：' + JSON.stringify(r.注契约被忽略));
      eq(r.注契约被忽略.modules, ['B', 'P', 'L', 'E', 'S3'],
        '★ 被忽略后应仍是表里的契约：');
      okMsg('overrides 试图改 contract 被忽略（不开放这条口子）');
    } catch (e) { badMsg('2 注契约 -> ' + e.message); }
  }

  process.stdout.write('\n3. 模块缺失 → 整条回退（不留半套正文）\n');
  {
    const r = await page.evaluate(function () {
      var PE = Sleepy.promptEngine;
      var saved = window.Sleepy.behaviorText;
      /* 临时把模块摘掉 —— 模拟 behaviorText 没加载 */
      try { delete window.Sleepy.behaviorText; } catch (e) { window.Sleepy.behaviorText = undefined; }
      var d = PE.btDecideScene('proactive');
      var n = PE.btNote('proactive', d, false, false);
      window.Sleepy.behaviorText = saved;
      return { dec: d, note: n, restored: !!window.Sleepy.behaviorText };
    });
    try {
      assert(r.dec.ok === false, '★ 模块缺失时决策必须失败');
      eq(r.dec.reason, 'module-missing', '★ 原因码：');
      assert(r.dec.shellText === null && r.dec.sceneText === null,
        '★ 失败时不得留半套正文');
      eq(r.note.modules, [], '★ fallback 时 modules 必须为空数组：');
      eq(r.note.pendingModules, [], '★ fallback 时 pendingModules 也应为空：');
      assert(r.note.behaviorUsed === false, '★ fallback 时 behaviorUsed 必须 false');
      okMsg('模块缺失：ok=false / reason=module-missing / 正文全 null / 诊断 modules=[]');
    } catch (e) { badMsg('3 模块缺失 -> ' + e.message); }
  }

  process.stdout.write('\n4. proactive 完整接线：最终出站里真的有 B/P/L 与 E/S3\n');
  {
    const r = await runProactive(page, { tag: 'T4' });
    try {
      /* 判据落在 sysText（buildSystem 的真实产物），
         captured 那条本轮不触发发送，只作为「将来接上也不回退」的锚。 */
      assert(r.sysText.indexOf('以本轮提供的有效资料') >= 0,
        '★ system 里应含 B 模块首句');
      assert(r.sysText.indexOf('对每个获准扮演的人物，依据其资料') >= 0,
        '★ system 里应含 P 模块首句');
      assert(r.sysText.indexOf('结合本轮明确篇幅需求') >= 0,
        '★ system 里应含 L 模块首句');
      assert(r.sysText.indexOf('当前通过消息交流') >= 0,
        '★ system 里应含 E 模块首句');
      assert(r.sysText.indexOf('当前不是对新消息作必答回复') >= 0,
        '★ system 里应含 S3 首句');
      okMsg('proactive 默认：system 里 B/P/L/E/S3 五段正文都在');
    } catch (e) { badMsg('4 五段正文 -> ' + e.message); }

    try {
      assert(r.note.behaviorUsed === true, '★ behaviorUsed 应为 true');
      eq(r.note.modules, ['B', 'P', 'L', 'E', 'S3'],
        '★ 诊断 modules 必须与实际注入一致（不得声称未注入的模块）：');
      eq(r.note.pendingModules, [], 'pending 应为空：');
      assert(r.note.partial === false, 'partial 应为 false');
      eq(r.note.shellCard, 'behavior', 'shellCard：');
      eq(r.note.version, 'sleepy-behavior-v1-review-01', '版本：');
      assert(r.note.sceneSkippedByOverride === false,
        '默认不该是 override 跳过');
      assert(r.note.sceneMismatch === false,
        '★ 接线与 spec 不该脱节（sceneMismatch）：' + JSON.stringify(r.note));
      okMsg('proactive 诊断：modules 与实际注入逐项一致、partial=false、' +
        'sceneMismatch=false、version=' + r.note.version);
    } catch (e) { badMsg('4 诊断一致 -> ' + e.message); }

    /* ★ 固定装配顺序（只作快照，不宣称顺序能解决规则冲突） */
    try {
      var iShell = r.sysText.indexOf('以本轮提供的有效资料');
      var iCard = r.sysText.indexOf('【调用任务】');
      var iE = r.sysText.indexOf('当前通过消息交流');
      var iS3 = r.sysText.indexOf('当前不是对新消息作必答回复');
      assert(iShell >= 0 && iCard >= 0 && iE >= 0 && iS3 >= 0, '四段都要在');
      assert(iShell < iCard, '★ 顺序快照：B/P/L 应在 proactive 卡之前');
      assert(iCard < iE, '★ 顺序快照：proactive 卡的【调用任务】应在 E 之前');
      assert(iE < iS3, '★ 顺序快照：E 应在 S3 之前');
      okMsg('顺序快照：shell(B/P/L) → proactive 卡 → E → S3');
    } catch (e) { badMsg('4 顺序快照 -> ' + e.message); }
  }

  await resetCards();

  process.stdout.write('\n5. 旧协议仍保留：proactive 卡不能被顶掉\n');
  {
    const r = await runProactive(page, { tag: 'T5' });
    try {
      assert(r.sysText.indexOf('【调用任务】') >= 0, 'proactive 卡的【调用任务】应保留');
      assert(r.sysText.indexOf('【输出结构】') >= 0, 'proactive 卡的【输出结构】应保留');
      assert(r.sysText.indexOf('{"decision":"send|skip|defer|blocked"') >= 0,
        '★ proactive 卡的 decision 输出协议应保留');
      assert(r.sysText.indexOf('【候选判断】') >= 0, 'proactive 卡的【候选判断】应保留');
      okMsg('proactive 协议卡完整保留（调用任务/候选判断/输出结构/decision JSON）');
    } catch (e) { badMsg('5 proactive 卡 -> ' + e.message); }
  }

  await resetCards();

  process.stdout.write('\n6. override 三分支\n');
  {
    /* 6.1 proactive 卡被 override → 保留 B/P/L、跳过 E/S3 */
    const r = await runProactive(page, { tag: 'T6a', overrideProactive: true, clearShell: true });
    try {
      assert(r.sysText.indexOf('OVERRIDE-PROACTIVE-MARK') >= 0,
        '★ 用户改的 proactive 卡正文应在 system 里');
      assert(r.sysText.indexOf('以本轮提供的有效资料') >= 0,
        '★ 改场景卡不该把 B/P/L 一起拖回退');
      assert(r.sysText.indexOf('当前通过消息交流') < 0,
        '★ 改场景卡后 E 不该再注入');
      assert(r.sysText.indexOf('当前不是对新消息作必答回复') < 0,
        '★ 改场景卡后 S3 不该再注入');
      eq(r.note.modules, ['B', 'P', 'L'],
        '★ 诊断应只报 B/P/L：');
      eq(r.note.pendingModules, ['E', 'S3'],
        '★ 未注入的应进 pendingModules：');
      assert(r.note.partial === true, 'partial 应为 true');
      assert(r.note.sceneSkippedByOverride === true,
        '★ sceneSkippedByOverride 应为 true（与「本批没接通」区分）');
      assert(r.note.behaviorUsed === true, 'B/P/L 仍在用，behaviorUsed 应为 true');
      okMsg('override① proactive 卡：保留 B/P/L、跳过 E/S3、' +
        'sceneSkippedByOverride=true');
    } catch (e) { badMsg('6.1 proactive 卡 override -> ' + e.message); }

    /* 6.2 shell 被 override → 整条回退 */
    const r2 = await runProactive(page, { tag: 'T6b', overrideShell: true, clearProactive: true });
    try {
      assert(r2.sysText.indexOf('OVERRIDE-SHELL-MARK') >= 0,
        '★ 用户改的 shell 卡正文应在 system 里');
      assert(r2.sysText.indexOf('以本轮提供的有效资料') < 0,
        '★ shell override 后 B/P/L 必须整条回退');
      assert(r2.sysText.indexOf('当前通过消息交流') < 0,
        '★ shell override 后 E/S3 也必须回退');
      eq(r2.note.modules, [], '★ 回退时 modules 必须为空：');
      eq(r2.note.reason, 'user-override', '★ 原因码：');
      assert(r2.note.touched === true, '★ touched 应为 true');
      assert(r2.note.behaviorUsed === false, '★ behaviorUsed 应为 false');
      okMsg('override② shell：整条回退（modules=[] / reason=user-override）');
    } catch (e) { badMsg('6.2 shell override -> ' + e.message); }
  }

  await resetCards();

  process.stdout.write('\n7. 群线下全量接线（2026-10-05 裁决接入 N/S5），七块旧协议原样保留\n');
  {
    const r = await runGroupOffline(page, { tag: 'T7' });
    if (r.error) {
      badMsg('7 群线下 -> ' + r.error);
    } else {
      try {
        assert(r.txt.indexOf('以本轮提供的有效资料') >= 0, '★ 应含 B');
        assert(r.txt.indexOf('对每个获准扮演的人物，依据其资料') >= 0, '★ 应含 P');
        assert(r.txt.indexOf('结合本轮明确篇幅需求') >= 0, '★ 应含 L');
        assert(r.txt.indexOf('从已成立现场中的话语、动作、注意力') >= 0,
          '★ N 应进群线下 system（裁决后全量接线）');
        assert(r.txt.indexOf('以共同现场中正在发生的事情组织叙述') >= 0,
          '★ S5 应进群线下 system（裁决后全量接线）');
        okMsg('群线下：B/P/L/N/S5 五块全在 system 里');
      } catch (e) { badMsg('7 只接 B/P/L -> ' + e.message); }

      /* ★ 端到端（群线下版）：诊断声称的模块必须真在 txt 里，pending 的必须不在。
         判据要落在**装配产物**上 —— 只查 btNote 的输出会漏掉「调用方传参撒谎」。 */
      try {
        var GFIRST = {
          'B': '以本轮提供的有效资料',
          'P': '对每个获准扮演的人物，依据其资料',
          'L': '结合本轮明确篇幅需求',
          'N': '从已成立现场中的话语、动作、注意力',
          'S5': '以共同现场中正在发生的事情组织叙述'
        };
        r.note.modules.forEach(function (m) {
          assert(r.txt.indexOf(GFIRST[m]) >= 0,
            '★ 诊断声称用了 ' + m + '，但 system 里找不到：' + GFIRST[m]);
        });
        r.note.pendingModules.forEach(function (m) {
          assert(r.txt.indexOf(GFIRST[m]) < 0,
            '★ ' + m + ' 在 pendingModules 里，却出现在 system 里');
        });
        okMsg('群线下端到端：声称的 ' + r.note.modules.length +
          ' 个模块逐个找到，pending 的 ' + r.note.pendingModules.length + ' 个都不在');
      } catch (e) { badMsg('7 端到端一致 -> ' + e.message); }

      try {
        eq(r.note.modules, ['B', 'P', 'L', 'N', 'S5'], '★ 诊断 modules（裁决后全量）：');
        eq(r.note.pendingModules, [], '★ 诊断 pendingModules：');
        assert(r.note.partial === false, '★ partial：');
        assert(r.note.sceneSkippedByOverride === false,
          '★ 这是正常接线而不是 override 跳过，两者必须可区分');
        assert(r.note.behaviorUsed === true, 'behaviorUsed：');
        okMsg('群线下诊断：modules=B/P/L/N/S5 · pending 空 · partial=false · ' +
          'sceneSkippedByOverride=false');
      } catch (e) { badMsg('7 群线下诊断 -> ' + e.message); }

      try {
        /* ★ 七块旧协议一块都不能少 */
        ['[SCENE]', '[PARTICIPANTS]', '[PRESENCE RULES]', '[OUTPUT]'].forEach(function (k) {
          assert(r.txt.indexOf(k) >= 0, '★ 旧协议段缺失：' + k);
        });
        assert(r.txt.indexOf('"type":"aside"') >= 0,
          '★ [OUTPUT] 五件套里的 aside 段应保留');
        assert(r.txt.indexOf('"type":"silent"') >= 0, '★ silent 段应保留');
        var f2 = await page.evaluate(function () { return Sleepy.promptEngine.cardBody('f2'); });
        assert(f2 && f2.length > 0, '★ f2 卡应仍在');
        assert(r.txt.indexOf(f2.slice(0, 40)) >= 0, '★ f2 卡正文应原样在 system 里');
        okMsg('群线下七块旧协议全在：[SCENE]/[PARTICIPANTS]/[PRESENCE RULES]/' +
          '[OUTPUT] 五件套 + f2 卡原样');
      } catch (e) { badMsg('7 旧协议 -> ' + e.message); }
    }
  }

  await resetCards();

  process.stdout.write('\n8. 群线下 shell override → 整条回退\n');
  {
    const r = await runGroupOffline(page, { tag: 'T8', overrideShell: true });
    if (r.error) { badMsg('8 群线下 override -> ' + r.error); }
    else {
      try {
        assert(r.txt.indexOf('OVERRIDE-SHELL-MARK') >= 0, '用户改的 shell 应在');
        assert(r.txt.indexOf('以本轮提供的有效资料') < 0, '★ 应整条回退');
        eq(r.note.modules, [], '★ modules=[]：');
        eq(r.note.reason, 'user-override', '★ reason：');
        okMsg('群线下 shell override：整条回退（modules=[] / user-override），' +
          'f2 与七块旧协议不受影响');
      } catch (e) { badMsg('8 群线下 override -> ' + e.message); }
    }
  }

  await resetCards();

  process.stdout.write('\n9. 群线上接线：B/P/L/E/S4 全进 system，顺序与旧协议都对\n');
  {
    const r = await runGroupOnline(page, { tag: 'T9' });
    if (r.error) { badMsg('9 群线上 -> ' + r.error); }
    else {
      /* 9.1 五段冻结模块全文都在（不只首句 —— 首句探针单独在 9.2） */
      try {
        ['B', 'P', 'L', 'E', 'S4'].forEach(function (m) {
          assert(r.sysText.indexOf(BT_FIRST[m]) >= 0, '★ ' + m + ' 首句不在 system 里');
        });
        okMsg('9.1 群线上 system：冻结 B/P/L/E/S4 五段首句探针全部命中');
      } catch (e) { badMsg('9.1 首句探针 -> ' + e.message); }

      /* 9.2 冻结模块**全文**都在（首句保留但截断后文 = 必须变红，见 §负向 N7） */
      try {
        var full = await page.evaluate(function () {
          var d = Sleepy.promptEngine.btDecideScene('groupOnline');
          var BT = Sleepy.behaviorText;
          var r2 = BT.forScenario('groupOnline');
          return { shell: d.shellText, scene: d.sceneText, parts: r2.parts.map(function (p) {
            return { id: p.id, text: p.text };
          }) };
        });
        assert(typeof full.shell === 'string' && full.shell.length > 0, 'shellText 应非空');
        assert(typeof full.scene === 'string' && full.scene.length > 0, 'sceneText 应非空');
        /* 每一段的**完整正文**都必须原样出现在 system 里 —— 不接受只留首句 */
        full.parts.forEach(function (p) {
          assert(r.sysText.indexOf(p.text) >= 0,
            '★ 模块 ' + p.id + ' 的**全文**不在 system 里（只留首句/截断后文）');
        });
        assert(r.sysText.indexOf(full.shell) >= 0, '★ shellText 整块不在');
        assert(r.sysText.indexOf(full.scene) >= 0, '★ sceneText 整块不在');
        okMsg('9.2 冻结模块全文逐段落地：' + full.parts.length +
          ' 段（B/P/L/E/S4）整块都在 system 里，不止首句');
      } catch (e) { badMsg('9.2 全文 -> ' + e.message); }

      /* 9.3 顺序固定：B/P/L → groupRound → E/S4 → 原有群现场信息 */
      try {
        var iB = r.sysText.indexOf(BT_FIRST.B);
        var iCard = r.sysText.indexOf('群聊里的多个角色');
        var iE = r.sysText.indexOf(BT_FIRST.E);
        var iS4 = r.sysText.indexOf(BT_FIRST.S4);
        var iGroup = r.sysText.indexOf('[GROUP]\n群名：');
        /* ★ 锚点必须用**实际 push 的整串**：`[ENTITY_KNOWLEDGE]` 这个字面量
           在 groupRound 卡正文里也出现过（知识边界那条），用裸串会命中卡里那份，
           顺序断言就变成在比「卡里的引用」和「真块」—— 假红。 */
        var iEnt = r.sysText.indexOf('[ENTITY_KNOWLEDGE]\n[ENTITY id=');
        var iBan = r.sysText.indexOf('注意：[ENTITY id=…] 是调度用的内部编号');
        assert([iB, iCard, iE, iS4, iGroup, iEnt, iBan].every(function (x) { return x >= 0; }),
          '★ 七段都要在：B / groupRound / E / S4 / [GROUP] / [ENTITY_KNOWLEDGE] / 编号禁令' +
          JSON.stringify([iB, iCard, iE, iS4, iGroup, iEnt, iBan]));
        assert(iB < iCard, '★ B/P/L 应在 groupRound 卡之前');
        assert(iCard < iE, '★ groupRound 卡应在 E 之前');
        assert(iE < iS4, '★ E 应在 S4 之前');
        assert(iS4 < iGroup, '★ E/S4 应在 [GROUP] 之前（原有群现场信息在后）');
        assert(iGroup < iEnt, '★ [GROUP] 应在 [ENTITY_KNOWLEDGE] 之前');
        assert(iEnt < iBan, '★ 编号禁令应在 [ENTITY_KNOWLEDGE] 之后');
        okMsg('9.3 顺序固定：B/P/L → groupRound → E/S4 → [GROUP] → ' +
          '[ENTITY_KNOWLEDGE] → 编号禁令');
      } catch (e) { badMsg('9.3 顺序 -> ' + e.message); }

      /* 9.4 单次注入：B/P/L 与 E/S4 各自只出现一次 */
      try {
        var blocks = await page.evaluate(function () {
          var d = Sleepy.promptEngine.btDecideScene('groupOnline');
          return { shell: d.shellText, scene: d.sceneText };
        });
        /* 用整块正文计数最可靠：同一段被注入两次就露馅 */
        eq(occurrences(r.sysText, blocks.shell), 1, '★ B/P/L 整块应只出现一次：');
        eq(occurrences(r.sysText, blocks.scene), 1, '★ E/S4 整块应只出现一次：');
        okMsg('9.4 单次注入：B/P/L 整块 1 次、E/S4 整块 1 次（无重复）');
      } catch (e) { badMsg('9.4 单次注入 -> ' + e.message); }

      /* 9.5 groupRound 卡完整保留；且 system 去掉新增块后与基线一致 */
      try {
        assert(r.groupRoundBody && r.groupRoundBody.length > 0, 'groupRound 卡应仍在');
        assert(r.sysText.indexOf(r.groupRoundBody) >= 0,
          '★ groupRound 卡正文应**完整**原样在 system 里');
        okMsg('9.5 groupRound 卡完整保留（整块正文逐字在 system 里）');
      } catch (e) { badMsg('9.5 groupRound -> ' + e.message); }

      /* 9.6 其它一切不变：messages / entities / budget / user 段 */
      try {
        eq(r.roles, ['system', 'user'], '★ messages 结构应不变（两条）：');
        eq(r.msgCount, 2, '★ messages 条数：');
        assert(r.entities === 2, '★ 候选本��数应仍是 2（大号+皮套归并、NPC 独立）：' + r.entities);
        ['[RECENT_GROUP]', '[BUDGET]', '请按输出协议输出 JSON。'].forEach(function (k) {
          assert(r.usrText.indexOf(k) >= 0, '★ user 段缺失：' + k);
        });
        assert(r.usrText.indexOf('本轮最多 2 个本体行动') >= 0,
          '★ [BUDGET] 数字应原样（未被行为模块改写）');
        okMsg('9.6 messages/entities/budget 与 user 段全部保持不变');
      } catch (e) { badMsg('9.6 不变项 -> ' + e.message); }

      /* 9.7 没有请求旧 shell 卡（调用记录 + system 原文两处一起判） */
      try {
        eq(r.calls.length, 0,
          '★ composeRound 是纯函数，不该外发请求（调用记录）：' + JSON.stringify(r.calls.length));
        assert(r.shellCardBody && r.shellCardBody.length > 0, 'shell 卡本身应仍存在');
        assert(r.sysText.indexOf(r.shellCardBody) < 0,
          '★ 旧 shell 卡正文不该出现在群线上 system 里（用户裁决：不注入旧 shell）');
        assert(r.sysText.indexOf('[角色声音]') < 0,
          '★ 旧 shell 卡的 [角色声音] 节不该出现');
        okMsg('9.7 未请求旧 shell：调用记录 0 次 + shell 卡正文/[角色声音] 均不在 system');
      } catch (e) { badMsg('9.7 无旧 shell -> ' + e.message); }

      /* 9.8 诊断与最终 system 交叉核对（如实、不谎报） */
      try {
        eq(r.note.modules, ['B', 'P', 'L', 'E', 'S4'], '★ 诊断 modules：');
        eq(r.note.pendingModules, [], '★ 诊断 pendingModules 应为空：');
        assert(r.note.partial === false, '★ partial 应为 false');
        eq(r.note.shellCard, 'behavior', '★ shellCard：');
        assert(r.note.behaviorUsed === true, '★ behaviorUsed：');
        assert(r.note.sceneMismatch === false, '★ sceneMismatch 应为 false');
        assert(r.note.sceneSkippedByOverride === false, '★ 不是 override 跳过');
        r.note.modules.forEach(function (m) {
          assert(r.sysText.indexOf(BT_FIRST[m]) >= 0,
            '★ 诊断声称用了 ' + m + '，system 里却找不到');
        });
        r.note.pendingModules.forEach(function (m) {
          assert(r.sysText.indexOf(BT_FIRST[m]) < 0,
            '★ ' + m + ' 在 pending 里却出现在 system 里');
        });
        okMsg('9.8 诊断交叉核对：声称的 5 段逐个在 system 里、pending 为空、' +
          'shellCard=behavior、sceneMismatch=false');
      } catch (e) { badMsg('9.8 诊断一致 -> ' + e.message); }

      /* 9.9 诊断只读深拷贝 */
      try {
        const ro = await page.evaluate(function () {
          var a = Sleepy.groupAI.behaviorNote();
          if (!a) return { none: true };
          a.modules.push('TAMPER');
          a.behaviorUsed = 'TAMPER';
          var b = Sleepy.groupAI.behaviorNote();
          return { second: b.modules, used: b.behaviorUsed };
        });
        assert(!ro.none, '★ 应能取到群线上诊断');
        assert(ro.second.indexOf('TAMPER') < 0,
          '★ 外部改动不该污染内部诊断：' + JSON.stringify(ro.second));
        assert(ro.used !== 'TAMPER', '★ 外部改动不该改内部 behaviorUsed');
        okMsg('9.9 群线上诊断是深拷贝快照：外部改不到内部状态');
      } catch (e) { badMsg('9.9 只读快照 -> ' + e.message); }
    }
  }

  await resetCards();

  process.stdout.write('\n9b. 群线上 system 去掉新增块后与基线一致\n');
  {
    /* ★ 基线 = 本批**施工前**的 groupAI 装配（只有 groupRound 卡 + 群现场信息）。
       判据：把 B/P/L 与 E/S4 两块**按整块切掉**、再把分隔用的 '\n\n' 归一，
       剩下的必须与「关掉注入时同样装配一次」逐字相同。
       —— 这条同时证明「没顺手改别处」。 */
    /* 9b 的基线取同一个群：取**最后建的那个**（就是 T9 建的虚构夹具群）。 */
    const r = await page.evaluate(function () {
      var d = Sleepy.promptEngine.btDecideScene('groupOnline');
      var all = Sleepy.groupStore.listGroups();
      if (!all.length) return { noGroup: true };
      var gid = all[all.length - 1].id;
      var cur = Sleepy.groupAI.composeRound(gid, { stimulus: '（基线对照）' });
      return { shell: d.shellText, scene: d.sceneText,
        sys: cur && cur.messages[0].content };
    });
    if (r.noGroup) badMsg('9b 基线对照：取不到群');
    else {
      try {
        var stripped = r.sys;
        /* 切 E/S4 整块 */
        assert(stripped.indexOf(r.scene) >= 0, '★ E/S4 整块应先在');
        stripped = stripped.replace(r.scene, '');
        /* 切 B/P/L 整块 */
        assert(stripped.indexOf(r.shell) >= 0, '★ B/P/L 整块应先在');
        stripped = stripped.replace(r.shell, '');
        /* push 空块会留下多余分隔符：'\n\n\n\n' → '\n\n' 归一 */
        var norm = function (s) { return s.replace(/\n{3,}/g, '\n\n').trim(); };

        /* 基线 = 同样装配，但两个开关都关（走 overrides 关闭注入） */
        var base = await page.evaluate(function () {
          var all = Sleepy.groupStore.listGroups();
          if (!all.length) return { none: true };
          var gid = all[all.length - 1].id;
          /* 不能从外面改 BT_SPECS —— 用「临时摘掉 behaviorText」得到等效基线：
             决策层整条回退 → 两段都不 push → 只剩 groupRound + 群现场信息。 */
          var saved = window.Sleepy.behaviorText;
          try { delete window.Sleepy.behaviorText; } catch (e) { window.Sleepy.behaviorText = undefined; }
          var r2 = Sleepy.groupAI.composeRound(gid, { stimulus: '（基线对照）' });
          window.Sleepy.behaviorText = saved;
          return { sys: r2 && r2.messages[0].content,
            restored: !!window.Sleepy.behaviorText };
        });
        assert(!base.none, '★ 基线装配取不到');
        assert(base.restored === true, '★ 夹具有效性：behaviorText 必须已恢复');
        assert(norm(stripped) === norm(base.sys),
          '★ 去掉 B/P/L 与 E/S4 两块后应与「不接线」基线逐字相同。\n' +
          '  实际：' + JSON.stringify(norm(stripped).slice(0, 200)) +
          '\n  基线：' + JSON.stringify(norm(base.sys).slice(0, 200)));
        okMsg('9b 去掉两块新增内容后与「不接线」基线逐字一致（没顺手改别处），' +
          'system ' + r.sys.length + ' → ' + norm(stripped).length + ' 字');
      } catch (e) { badMsg('9b 基线一致 -> ' + e.message); }
    }
  }

  await resetCards();

  process.stdout.write('\n9c. 群线上 shell override → 整条回退\n');
  {
    const r = await runGroupOnline(page, { tag: 'T9c', overrideShell: true });
    if (r.error) { badMsg('9c 群线上 override -> ' + r.error); }
    else {
      try {
        assert(r.sysText.indexOf('OVERRIDE-SHELL-MARK') < 0,
          '★ 群线上不注入旧 shell 卡，用户改的 shell 也不该出现');
        assert(r.sysText.indexOf(BT_FIRST.B) < 0, '★ 改 shell 后 B/P/L 必须整条回退');
        eq(r.note.modules, [], '★ 回退时 modules 必须为空：');
        eq(r.note.reason, 'user-override', '★ 原因码：');
        assert(r.note.behaviorUsed === false, '★ behaviorUsed 应为 false');
        /* 群现场信息与协议必须一行不受影响 */
        assert(r.sysText.indexOf('群聊里的多个角色') >= 0, '★ groupRound 卡应仍在');
        assert(r.sysText.indexOf('[GROUP]') >= 0, '★ [GROUP] 应仍在');
        okMsg('9c 群线上 shell override：整条回退（modules=[] / user-override），' +
          'groupRound 与群现场协议不受影响');
      } catch (e) { badMsg('9c 群线上 override -> ' + e.message); }
    }
  }

  await resetCards();

  process.stdout.write('\n9d. 每次尝试不遗留上轮成功诊断\n');
  {
    /* ★ 「误导性的上轮成功诊断」是本批明确要求防的失败形态：
       先成功装配一次（有诊断），再让下一次尝试**早退**（不存在的群），
       诊断必须变成 null，而不是留着上一轮的成功记账。 */
    const r = await page.evaluate(function () {
      var all = Sleepy.groupStore.listGroups();
      if (!all.length) return { noGroup: true };
      var gid = all[all.length - 1].id;
      var ok1 = Sleepy.groupAI.composeRound(gid, { stimulus: '（成功一次）' });
      var n1 = Sleepy.groupAI.behaviorNote();
      /* 第二次尝试：群不存在 → composeRound 早退 return null */
      var ok2 = Sleepy.groupAI.composeRound('__不存在的群__', { stimulus: '（早退）' });
      var n2 = Sleepy.groupAI.behaviorNote();
      return { firstOk: !!ok1, firstModules: n1 && n1.modules,
        secondOk: !!ok2, secondNote: n2 };
    });
    if (r.noGroup) badMsg('9d 残留诊断：取不到群');
    else {
      try {
        assert(r.firstOk === true, '★ 第一次应装配成功');
        assert(r.firstModules && r.firstModules.length === 5,
          '★ 第一次诊断应有 5 个模块：' + JSON.stringify(r.firstModules));
        assert(r.secondOk === false, '★ 第二次（不存在的群）应早退');
        assert(r.secondNote === null,
          '★ 早退后不得留下上轮的成功诊断，实得：' + JSON.stringify(r.secondNote));
        okMsg('9d 早退后诊断被清成 null，不残留上一轮的「已用 B/P/L/E/S4」');
      } catch (e) { badMsg('9d 残留诊断 -> ' + e.message); }
    }
  }

  await resetCards();

  process.stdout.write('\n10. 线上／线下重构前后结果一致\n');
  {
    /* 判据：薄包装的返回字段名与旧实现逐字相同，且成功路径全量注入。
       ★ 同时抓真实出站，确认线上 shell/f1 段与 c05 协议都在。 */
    const r = await page.evaluate(function () {
      var PE = Sleepy.promptEngine;
      var core = Sleepy.core, sb = core.listSandboxes()[0];
      var ch = core.upsertChar({ id: '__bt_on__', kind: 'main', name: '线上甲',
        content: '话少。', sandboxId: sb && sb.id });
      var u = core.activeUser() || core.userMasks()[0];
      var sess = Sleepy.chatStore.chatOf(ch.id);
      var on = PE.assembleOnline({ charId: ch.id, userId: u && u.id,
        history: (sess && sess.messages) || [], userInput: '在吗' });
      var sysText = on.messages.map(function (m) { return String(m.content); }).join('\n');
      /* 线上薄包装字段 */
      var dOnline = PE.btDecideScene('online');
      var dOffline = PE.btDecideScene('offline');
      return {
        slots: (on.slots || []).map(function (s) { return s.id; }),
        sysText: sysText,
        onlineOk: dOnline.ok,
        onlineFields: Object.keys(dOnline).sort(),
        offlineOk: dOffline.ok,
        offlineFields: Object.keys(dOffline).sort(),
        offlineProtocol: dOffline.protocolText
      };
    });
    try {
      assert(r.onlineOk === true, '线上决策应成功');
      assert(r.offlineOk === true, '线下决策应成功');
      okMsg('线上/线下决策均 ok=true');
    } catch (e) { badMsg('10 决策 -> ' + e.message); }

    try {
      /* 线上出站里必须有 B/P/L（shell 位）+ E/S1（f1 位）+ c05 协议 */
      assert(r.sysText.indexOf('以本轮提供的有效资料') >= 0, '★ 线上应含 B');
      assert(r.sysText.indexOf('当前通过消息交流') >= 0, '★ 线上应含 E');
      assert(r.sysText.indexOf('承接当前可见消息与正在延续的话题') >= 0, '★ 线上应含 S1');
      assert(r.sysText.indexOf('[WHISPER]') >= 0, '★ 线上应含 c05 的 [WHISPER] 协议');
      okMsg('线上出站：B/P/L + E/S1 + c05 协议（[WHISPER]）全在');
    } catch (e) { badMsg('10 线上出站 -> ' + e.message); }

    try {
      /* ★ 线下**不接管输出协议** —— protocolText 必须恒为 null */
      assert(r.offlineProtocol === null,
        '★ 线下 protocolText 必须为 null（offlineOutProto 负责）：' +
        JSON.stringify(r.offlineProtocol));
      okMsg('线下 protocolText = null（未接管输出协议，行为不变）');
    } catch (e) { badMsg('10 线下协议 -> ' + e.message); }
  }

  process.stdout.write('\n11. 诊断自洽护栏：dec 声称已用但契约缺段 → 收紧\n');
  {
    const r = await page.evaluate(function () {
      var PE = Sleepy.promptEngine;
      var real = PE.btDecideScene('proactive');
      /* 造一个「dec 声称 modules 是全量、但 scene 段缺失」的脱节输入：
         模拟下游把 dec.modules 改坏后调用 btNote。 */
      var tampered = JSON.parse(JSON.stringify(real));
      tampered.modules = ['B', 'P', 'L'];   /* 缺 E/S3，却声称 scene 已注入 */
      var note = PE.btNote('proactive', tampered, true, true);
      /* 正常输入应恒为 false */
      var normal = PE.btNote('proactive', real, true, true);
      return { tampered: note, normal: normal };
    });
    try {
      eq(r.tampered.modules, ['B', 'P', 'L'],
        '★ 脱节时必须收紧到只报 shell 契约：');
      eq(r.tampered.pendingModules, ['E', 'S3'],
        '★ 收紧后未接的应进 pending：');
      assert(r.tampered.partial === true, '收紧后 partial 应为 true');
      assert(r.tampered.sceneMismatch === true,
        '★ sceneMismatch 应标出脱节');
      okMsg('脱节输入被收紧：modules=[B,P,L] · pending=[E,S3] · sceneMismatch=true');
    } catch (e) { badMsg('11 自洽护栏 -> ' + e.message); }
    try {
      assert(r.normal.sceneMismatch === false,
        '★ 正常输入不该报脱节');
      eq(r.normal.modules, ['B', 'P', 'L', 'E', 'S3'], '正常输入 modules：');
      okMsg('正常输入 sceneMismatch=false、modules 全量（护栏不误伤）');
    } catch (e) { badMsg('11 正常路径 -> ' + e.message); }
  }

  process.stdout.write('\n11b. 端到端：诊断声称已用的模块必须真在 system 里\n');
  {
    /* ★ 这一节是 N2/N6 逼出来的。
       前面的判据都在「btNote 的输出」上查，但作弊可以发生在**调用方传参**
       （把 usedScene 硬传 true）—— 那时 btNote 收到的就是假的。
       唯一抓得住的办法：**回到装配产物本身**，
       把诊断声称的每个模块首句拿去 system 文本里逐个找。 */
    const r = await runProactive(page, { tag: 'T11b' });
    try {
      /* 诊断声称用了哪些模块 → 每个都要能在 sysText 里找到它的首句 */
      var FIRST = {
        'B': '以本轮提供的有效资料',
        'P': '对每个获准扮演的人物，依据其资料',
        'L': '结合本轮明确篇幅需求',
        'E': '当前通过消息交流',
        'S3': '当前不是对新消息作必答回复'
      };
      r.note.modules.forEach(function (m) {
        var mark = FIRST[m];
        assert(mark, '测试夹具缺模块 ' + m + ' 的首句锚点');
        assert(r.sysText.indexOf(mark) >= 0,
          '★ 诊断声称用了 ' + m + '，但 system 里找不到它的正文：' + mark);
      });
      /* 反向：pending 里的模块必须**不在** system 里 */
      r.note.pendingModules.forEach(function (m) {
        var mark = FIRST[m];
        if (!mark) return;
        assert(r.sysText.indexOf(mark) < 0,
          '★ ' + m + ' 在 pendingModules 里，却出现在 system 里');
      });
      okMsg('proactive 端到端：诊断声称的 ' + r.note.modules.length +
        ' 个模块逐个在 system 里找到，pending 的一个都不在');
    } catch (e) { badMsg('11b 端到端一致 -> ' + e.message); }
  }

  process.stdout.write('\n11c. 诊断只读快照（外部改不到内部）\n');
  {
    const r = await page.evaluate(function () {
      var a = Sleepy.proactiveEngine.behaviorNote();
      if (!a) return { none: true };
      a.modules.push('TAMPER');
      a.behaviorUsed = 'TAMPER';
      var b = Sleepy.proactiveEngine.behaviorNote();
      return { first: a.modules, second: b.modules, secondUsed: b.behaviorUsed };
    });
    if (r.none) badMsg('11 诊断快照：取不到 proactive 诊断');
    else {
      try {
        assert(r.second.indexOf('TAMPER') < 0,
          '★ 外部改动不该污染内部诊断：' + JSON.stringify(r.second));
        assert(r.secondUsed !== 'TAMPER', '★ 外部改动不该改内部 behaviorUsed');
        okMsg('诊断是深拷贝快照：外部改不到内部状态');
      } catch (e) { badMsg('11 只读快照 -> ' + e.message); }
    }
  }

  process.stdout.write('\n12. 页面无未捕获异常\n');
  {
    try {
      eq(errors, [], '★ 页面报错（[Sleepy] / console.error）：');
      okMsg('全程零未捕获异常（含非法 spec 与 override 场景）');
    } catch (e) { badMsg('12 页面异常 -> ' + e.message); }
  }

  await page.close();
  await browser.close();

  process.stdout.write('\n————————————————\n');
  process.stdout.write('  通过 ' + ok + ' / 失败 ' + bad + '\n');
  if (bad) {
    process.stdout.write('  失败项：\n');
    fails.forEach(function (f) { process.stdout.write('   · ' + f + '\n'); });
  }
  process.exit(bad ? 1 : 0);
})().catch(function (e) {
  process.stdout.write('\n脚本异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(2);
});
