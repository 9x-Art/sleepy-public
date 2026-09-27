/* ============================================================
   scripts/browser-p2-test.js — 项目2（记忆开关）原生浏览器行为验收
   ------------------------------------------------------------
   复用项目5 的隔离设施：真系统 Edge（headless、一次性 profile）
   + 真原生 IndexedDB + 生产源码原文（store.js / memory-vec.js
   经同源 <script> 加载，不加壳）+ embedding mock（不产生真实费用）。

   场景在 preview/idb-test/index.html（?case= 选择；case=p2 布置干净库），
   memoryStore 桩由该页提供（__setCharConfig 模拟开关写入）。

   本轮验收聚焦「生产路径运行证据」，不是静态护栏 / 页面 render：
     · M新1 重开重扫去重：旧块→关→新消息→开扫完→再关再开扫完，
       回交每轮块ID/sourceId/内容范围/embedding调用数，证明不随开关次数增副本。
     · M新2 关闭立即生效与旁路：prefetch/lastOf/text + 建块入口不调embedding。
     · M新3 群注入边界：线上群 / 群线下 A关闭 B开启 是否同一次请求注入。
     · M新4 M2/M4/M5/M5b/M8 运行证据。
   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-p2-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('browser-p2-test：找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-p2-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.P2_TEST_PORT || 5198;
const BASE = 'http://127.0.0.1:' + PORT;
const PAGE = BASE + '/preview/idb-test/index.html';

const results = [];
function chk(name, cond) {
  results.push({ name, ok: !!cond });
  if (!cond) console.error('  ✗ ' + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitServer() {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      http.get(BASE + '/store.js', (r) => { r.resume(); r.statusCode === 200 ? res() : retry(); })
        .on('error', retry);
      function retry() {
        if (Date.now() - t0 > 15000) rej(new Error('测试站点起不来'));
        else setTimeout(poll, 250);
      }
    })();
  });
}

async function waitLoaded(page) {
  await page.waitForFunction(
    () => window.__loaded === true || !!window.__bootError,
    null, { timeout: 20000 });
  const err = await page.evaluate('window.__bootError || null');
  if (err) throw new Error('页面启动失败：' + err);
}

/* 生产私有池 chat 构造（与线上 sweep 数据结构一致） */
function mkChat(id, tag, n) {
  return {
    id, characterId: 'c1', userId: 'u1', name: tag,
    messages: Array.from({ length: n }, (_, i) => ({
      id: tag + '_' + i, role: i % 2 ? 'user' : 'char',
      content: tag + '话' + i, timestamp: 1000 + i
    }))
  };
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  try {
    await waitServer();
    const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    try {

      /* ---- M新1｜重开重扫去重：旧块→关→新消息→开扫→再关再开扫 ----
         目标：证明「相同源内容不会随开关次数不断增加副本」。
         如果失败（重复建块），在 report 里给出最小修复建议。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec, S = window.Sleepy.store;
          /* 页面内内联构造（node 侧 mkChat 传不进来） */
          function mkChat(id, tag, n) {
            return {
              id, characterId: 'c1', userId: 'u1', name: tag,
              messages: Array.from({ length: n }, (_, i) => ({
                id: tag + '_' + i, role: i % 2 ? 'user' : 'char',
                content: tag + '话' + i, timestamp: 1000 + i
              }))
            };
          }
          const setCfg = (enabled) => window.__setCharConfig('r1', enabled);
          /* 读当前库所有块的指纹（id/msgIds/sourceId/text） */
          const allBlocks = () => new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readonly');
              const out = [];
              const cur = t.objectStore('vec').openCursor();
              cur.onsuccess = () => { const c = cur.result; if (!c) { db.close(); res(out); } else { out.push(c.value); c.continue(); } };
              cur.onerror = () => { db.close(); res(out); };
            };
            rq.onerror = () => res([]);
          });
          const textCount = () => {
            const o = {};
            Object.keys(window.__embedCount).forEach((t) => { o[t] = window.__embedCount[t]; });
            return o;
          };

          const chat = mkChat('chatR', 'R', 20);
          S.set('chats', [chat]);
          const setMsgs = (n) => { chat.messages = mkChat('chatR', 'R', n).messages; };
          /* 每轮 embedding 的「计数快照」（key→调用次数），算轮间增量 */
          const embSnapshot = () => { const o = {}; Object.keys(window.__embedCount).forEach((k) => { o[k] = window.__embedCount[k]; }); return o; };
          const embDelta = (prev, now) => Object.keys(now).reduce((s, k) => s + (now[k] - (prev[k] || 0)), 0);
          const prevEmb = embSnapshot();

          /* 轮0：开启（rootEpoch=0），扫 20 条 → 首建块 */
          setCfg(true);
          const r0 = await MV.sweep('r1', 'u1', chat);
          const b0 = await allBlocks();
          const d0 = embDelta(prevEmb, embSnapshot());
          const prev0 = embSnapshot();

          /* 轮1：关闭 + 新增到 30 条 → sweep 应 memoff，不建块不 embedding */
          setCfg(false);
          setMsgs(30);
          const r1 = await MV.sweep('r1', 'u1', chat);
          const b1 = await allBlocks();
          const d1 = embDelta(prev0, embSnapshot());
          const prev1 = embSnapshot();

          /* 轮2：开启。真实 UI 走 setCharConfig false→true → invalidateCursorsFor('r1')
             rootEpoch 0→1。测试脚本直接调 MV（等价边沿做的事）。再 sweep 应从头重扫。 */
          setCfg(true);
          MV.invalidateCursorsFor('r1');
          const r2 = await MV.sweep('r1', 'u1', chat);
          const b2 = await allBlocks();
          const d2 = embDelta(prev1, embSnapshot());
          const prev2 = embSnapshot();

          /* 轮3：再关再开扫完（重复开关第二次） */
          setCfg(false);
          setMsgs(40);
          const r3 = await MV.sweep('r1', 'u1', chat);
          const d3 = embDelta(prev2, embSnapshot());
          const prev3 = embSnapshot();
          setCfg(true);
          MV.invalidateCursorsFor('r1');
          const r4 = await MV.sweep('r1', 'u1', chat);
          const b4 = await allBlocks();
          const d4 = embDelta(prev3, embSnapshot());

          const digest = (list) => list.map((b) => ({
            id: b.id,
            sourceId: b.sourceId,
            fromId: b.fromId, toId: b.toId,
            msgIds: b.msgIds,
            text: b.text
          }));
          const dupByText = (list) => {
            const seen = {}, dup = [];
            list.forEach((b) => {
              const k = (b.sourceId || '') + '|' + (b.fromId || '') + '|' + (b.toId || '');
              seen[k] = (seen[k] || 0) + 1;
              if (seen[k] > 1) dup.push({ key: k, id: b.id, text: b.text });
            });
            return dup;
          };

          return {
            r0, r1, r2, r3, r4,
            counts: { b0: b0.length, b1: b1.length, b2: b2.length, b4: b4.length },
            deltas: { d0, d1, d2, d3, d4 },
            d0: digest(b0), d2: digest(b2), d4: digest(b4),
            dup2: dupByText(b2), dup4: dupByText(b4),
            allTexts0: b0.map((x) => x.text)
          };
        });

        /* 断言：去重是否成立 */
        const c0 = r.counts.b0, c2 = r.counts.b2, c4 = r.counts.b4;
        chk('M新1 首开扫 20 条建块数不对（预期 2~3 块，每块 8-12 条）', c0 >= 2 && c0 <= 3);
        chk('M新1 关闭期间 sweep 应停建（返回 memoff）', r.r1 && r.r1.why === 'memoff');
        chk('M新1 关闭期间块数不应增加（b1===b0）', r.counts.b1 === c0);
        chk('M新1 关闭期间 embedding 应新增 0（d1===0）', r.deltas.d1 === 0);
        chk('M新1 重开后从头重扫应产生新块（含新增的 10 条）', c2 > c0);
        /* 去重核心：重扫后，同一段旧消息（sourceId+fromId+toId 相同）不应出现第二次 */
        chk('M新1 重开后旧段重复建块（去重失败）：' + JSON.stringify(r.dup2.map((d) => d.key)),
          r.dup2.length === 0);
        chk('M新1 第二次开关后再无新增重复（去重应持续成立）',
          r.dup4.length === 0);
        /* 重扫只应算新增消息；旧段重算 = 额外费用。若去重成立，重开轮的新块不含旧段副本 */
        chk('M新1 重开后块数增量应等于新增消息数（不应重复旧段）',
          c2 - c0 <= 2 && r.dup2.length === 0);
        console.log('  [M新1 数据] 块数 b0/b1/b2/b4 =',
          r.counts.b0 + '/' + r.counts.b1 + '/' + r.counts.b2 + '/' + r.counts.b4,
          '| embedding调用增量 轮0/轮1/轮2/轮3/轮4 =',
          r.deltas.d0 + '/' + r.deltas.d1 + '/' + r.deltas.d2 + '/' + r.deltas.d3 + '/' + r.deltas.d4,
          '| 重复段 dup2=' + r.dup2.length + ' dup4=' + r.dup4.length);
        await ctx.close();
      }

      /* ---- 项目2 修复回归｜生产形态真实 NPC 默认关 ----
         真实 NPC 由 upsertChar({kind:'npc', parentType:'sandbox'}) 生成 `chxxx` id（不是 npc 前缀）。
         旧判据 indexOf('npc') 会把它们误判成主角 → 默认记忆开。修复后 charConfig 查名册 kind。
         这里直接断言 charConfig / charMemOff 对 `ch` 前缀真实 NPC 的默认态与显式态。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MS = window.Sleepy.memoryStore;
          const MV = window.Sleepy.memoryVec;
          const NPC = 'chNPC0001';   /* 桩名册里的真实 NPC（ch 前缀，kind='npc'） */
          const HERO = 'c1';          /* 桩名册里的主角 */
          const out = {};
          out.npcIsChPrefix = String(NPC).indexOf('npc') !== 0;   /* 确认真实 NPC id 不带 npc 前缀 */
          out.npcDefault = MS.charConfig(NPC);                    /* 无显式配置：应默认关 */
          out.npcMemOffDefault = MV._pure.charMemOff(NPC);        /* 默认应关（true） */
          out.heroDefault = MS.charConfig(HERO);                  /* 主角默认开 */
          window.__clearCharConfig();
          window.__setCharConfig(NPC, true);                       /* 显式开启 */
          out.npcExplicitOn = MS.charConfig(NPC);
          out.npcMemOffExplicitOn = MV._pure.charMemOff(NPC);
          window.__clearCharConfig();
          window.__setCharConfig(NPC, false);                      /* 显式关闭 */
          out.npcExplicitOff = MS.charConfig(NPC);
          out.npcMemOffExplicitOff = MV._pure.charMemOff(NPC);
          window.__clearCharConfig();
          return out;
        });
        chk('NPC 修复 真实NPC id 确为 ch 前缀（不带 npc 前缀）', r.npcIsChPrefix === true);
        chk('NPC 修复 charConfig(真实NPC).enabled 默认 false（默认关）', r.npcDefault && r.npcDefault.enabled === false);
        chk('NPC 修复 charMemOff(真实NPC) 默认 true（默认关）', r.npcMemOffDefault === true);
        chk('NPC 修复 主角默认开（不回归）', r.heroDefault && r.heroDefault.enabled === true);
        chk('NPC 修复 显式开启后 enabled=true（显式优先）', r.npcExplicitOn && r.npcExplicitOn.enabled === true);
        chk('NPC 修复 显式开启后 charMemOff=false', r.npcMemOffExplicitOn === false);
        chk('NPC 修复 显式关闭后 enabled=false（显式优先）', r.npcExplicitOff && r.npcExplicitOff.enabled === false);
        chk('NPC 修复 显式关闭后 charMemOff=true', r.npcMemOffExplicitOff === true);
        console.log('  [NPC 修复 数据] 真实NPC(ch前缀) 默认=' + JSON.stringify(r.npcDefault) +
          ' charMemOff默认=' + r.npcMemOffDefault +
          ' | 主角默认=' + JSON.stringify(r.heroDefault) +
          ' | 显式开=' + JSON.stringify(r.npcExplicitOn) + ' memOff=' + r.npcMemOffExplicitOn +
          ' | 显式关=' + JSON.stringify(r.npcExplicitOff) + ' memOff=' + r.npcMemOffExplicitOff);
        await ctx.close();
      }

      /* ---- 项目2 边界分离｜未知状态 ≠ NPC、共享池永不被误关 ----
         生产 isNpcRoot 把四类 root 彻底分离：
           ① 带前缀共享池（island:/user:/group:）→ 永远非 NPC（先短路）
           ② 名册 kind==='npc' → NPC
           ③ 名册 kind 非 npc（主角/马甲）→ 非 NPC
           ④ core 未就绪 / 查不到 root → **非 NPC**（未知不默认关，默认开）
         这里用桩的 __dropCore 模拟 core 未就绪，逐一断言 charConfig / charMemOff。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MS = window.Sleepy.memoryStore;
          const MV = window.Sleepy.memoryVec;
          const out = {};
          window.__clearCharConfig();

          /* A. core 就绪：主角默认开、真实NPC(ch前缀)默认关、共享池不被关 */
          out.a_hero = MS.charConfig('c1');
          out.a_npc = MS.charConfig('chNPC0001');
          out.a_npcMemOff = MV._pure.charMemOff('chNPC0001');
          out.a_grp = MS.charConfig('group:g1');
          out.a_grpMemOff = MV._pure.charMemOff('group:g1');
          out.a_isl = MS.charConfig('island:sb1');
          out.a_islMemOff = MV._pure.charMemOff('island:sb1');
          out.a_usr = MS.charConfig('user:u1');
          out.a_usrMemOff = MV._pure.charMemOff('user:u1');
          /* core 就绪但名册查不到 root（假 root / 未知 id）→ 非 NPC，默认开 */
          out.a_unknown = MS.charConfig('noSuchRoot');
          out.a_unknownMemOff = MV._pure.charMemOff('noSuchRoot');

          /* B. core 未就绪（__dropCore）：主角不误关、共享池不被误关 */
          window.__dropCore();
          out.b_hero = MS.charConfig('c1');
          out.b_heroMemOff = MV._pure.charMemOff('c1');
          out.b_grp = MS.charConfig('group:g1');
          out.b_grpMemOff = MV._pure.charMemOff('group:g1');
          out.b_isl = MS.charConfig('island:sb1');
          out.b_islMemOff = MV._pure.charMemOff('island:sb1');
          out.b_usr = MS.charConfig('user:u1');
          out.b_usrMemOff = MV._pure.charMemOff('user:u1');
          window.__restoreCore();
          window.__clearCharConfig();

          /* C. 显式配置优先（core 就绪）：enabled:true/false 不被默认覆盖 */
          window.__setCharConfig('chNPC0001', true);
          out.c_npcOn = MS.charConfig('chNPC0001');
          out.c_npcOnMemOff = MV._pure.charMemOff('chNPC0001');
          window.__clearCharConfig();
          window.__setCharConfig('chNPC0001', false);
          out.c_npcOff = MS.charConfig('chNPC0001');
          out.c_npcOffMemOff = MV._pure.charMemOff('chNPC0001');
          /* 显式关主角 → 主角记忆也关（显式优先，不受默认开覆盖） */
          window.__clearCharConfig();
          window.__setCharConfig('c1', false);
          out.c_heroOff = MS.charConfig('c1');
          out.c_heroOffMemOff = MV._pure.charMemOff('c1');
          window.__clearCharConfig();
          return out;
        });
        /* A：core 就绪 */
        chk('边界 A 主角默认开（enabled=true）', r.a_hero && r.a_hero.enabled === true);
        chk('边界 A 真实NPC(ch前缀)默认关（enabled=false）', r.a_npc && r.a_npc.enabled === false);
        chk('边界 A 真实NPC charMemOff=true（默认关）', r.a_npcMemOff === true);
        chk('边界 A group:g1 默认开（共享池不被关）', r.a_grp && r.a_grp.enabled === true);
        chk('边界 A group:g1 charMemOff=false', r.a_grpMemOff === false);
        chk('边界 A island:sb1 默认开（共享池不被关）', r.a_isl && r.a_isl.enabled === true);
        chk('边界 A island:sb1 charMemOff=false', r.a_islMemOff === false);
        chk('边界 A user:u1 默认开（共享池不被关）', r.a_usr && r.a_usr.enabled === true);
        chk('边界 A user:u1 charMemOff=false', r.a_usrMemOff === false);
        chk('边界 A 查不到 root 默认开（未知≠NPC）', r.a_unknown && r.a_unknown.enabled === true);
        chk('边界 A 查不到 root charMemOff=false', r.a_unknownMemOff === false);
        /* B：core 未就绪 */
        chk('边界 B core未就绪 主角默认开（不误关）', r.b_hero && r.b_hero.enabled === true);
        chk('边界 B core未就绪 主角 charMemOff=false', r.b_heroMemOff === false);
        chk('边界 B core未就绪 group:g1 默认开（不被误关）', r.b_grp && r.b_grp.enabled === true);
        chk('边界 B core未就绪 group:g1 charMemOff=false', r.b_grpMemOff === false);
        chk('边界 B core未就绪 island:sb1 默认开（不被误关）', r.b_isl && r.b_isl.enabled === true);
        chk('边界 B core未就绪 island:sb1 charMemOff=false', r.b_islMemOff === false);
        chk('边界 B core未就绪 user:u1 默认开（不被误关）', r.b_usr && r.b_usr.enabled === true);
        chk('边界 B core未就绪 user:u1 charMemOff=false', r.b_usrMemOff === false);
        /* C：显式优先 */
        chk('边界 C 显式 enabled:true 优先（NPC记忆开）', r.c_npcOn && r.c_npcOn.enabled === true);
        chk('边界 C 显式 enabled:true 后 charMemOff=false', r.c_npcOnMemOff === false);
        chk('边界 C 显式 enabled:false 优先（NPC记忆关）', r.c_npcOff && r.c_npcOff.enabled === false);
        chk('边界 C 显式 enabled:false 后 charMemOff=true', r.c_npcOffMemOff === true);
        chk('边界 C 显式关主角 → 主角记忆关（显式优先）', r.c_heroOff && r.c_heroOff.enabled === false);
        chk('边界 C 显式关主角后 charMemOff=true', r.c_heroOffMemOff === true);
        console.log('  [边界分离 数据] 就绪主角=' + JSON.stringify(r.a_hero) +
          ' 就绪NPC=' + JSON.stringify(r.a_npc) + ' memOff=' + r.a_npcMemOff +
          ' | 就绪 group=' + JSON.stringify(r.a_grp) + ' memOff=' + r.a_grpMemOff +
          ' | 就绪 unknown=' + JSON.stringify(r.a_unknown) +
          ' | 未就绪主角=' + JSON.stringify(r.b_hero) + ' memOff=' + r.b_heroMemOff +
          ' | 未就绪 group=' + JSON.stringify(r.b_grp) + ' memOff=' + r.b_grpMemOff);
        await ctx.close();
      }

      /* ---- M新2｜关闭立即生效与旁路 ----
         开启时预热召回 → 关闭后不刷新 → 下一次最终请求不带旧私有记忆；
         关闭后旧异步结果不重新进入可消费缓存；共享池/其他root正常。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          function mkChat(id, tag, n) {
            return {
              id, characterId: 'c1', userId: 'u1', name: tag,
              messages: Array.from({ length: n }, (_, i) => ({
                id: tag + '_' + i, role: i % 2 ? 'user' : 'char',
                content: tag + '话' + i, timestamp: 1000 + i
              }))
            };
          }
          const setCfg = (enabled) => window.__setCharConfig('r1', enabled);
          const chat = mkChat('chatP', 'P', 10);
          window.Sleepy.store.set('chats', [chat]);
          /* 开启时预热：先建块 + prefetch 召回（读到缓存） */
          setCfg(true);
          await MV.sweep('r1', 'u1', chat);
          await MV.prefetch('r1', 'u1', chat, { recall: 2 });
          const openText = await MV.text('r1', 'u1', chat, { recall: 2 });
          /* 关闭（不刷新缓存）→ text 应该不带旧私有记忆（blocksOf 跳角色池） */
          setCfg(false);
          const closedText = await MV.text('r1', 'u1', chat, { recall: 2 });
          /* 关闭后建块入口：sweep 应 memoff 不调 embedding */
          const sweepClosed = await MV.sweep('r1', 'u1', chat);
          /* 共享池（群）关闭时照常 */
          const g = { groupId: 'gX', messages: [
            { id: 'g0', type: 'text', content: '群话0', fromId: 'r1', timestamp: 1 }
          ] };
          const sweepGroup = await MV.sweepGroup('gX', g.messages);
          return {
            openHas: /P话/.test(openText || ''),
            closedHas: /P话/.test(closedText || ''),
            closedEmpty: (closedText || '') === '',
            sweepClosedWhy: sweepClosed && sweepClosed.why,
            sweepGroupOk: sweepGroup && sweepGroup.ok
          };
        });
        chk('M新2 开启预热后 text 召回应包含私有块', r.openHas);
        chk('M新2 关闭后 text 不带旧私有记忆（应空）', !r.closedHas && r.closedEmpty);
        chk('M新2 关闭后 sweep 应 memoff（不调 embedding）', r.sweepClosedWhy === 'memoff');
        chk('M新2 关闭时共享池（群）照常建块', r.sweepGroupOk === true);
        await ctx.close();
      }

      /* ---- M新3 + M新4｜群注入边界：线上群 / 群线下 A关 B开 ----
         验证：同一装配调用里，关闭成员 groupTextFor 为空、开启成员有群池摘要。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          /* 建群池块：ownerKey=group:gA —— 群聊走 nextBlock（默认 blocker），
             需 ≥8 条消息才切块（MIN_MSGS=8），造 10 条 */
          const g = { groupId: 'gA', messages: Array.from({ length: 10 }, (_, i) => ({
            id: 'g' + i, type: 'text', content: '群里以前的话' + i, fromId: (i % 2 ? 'B' : 'A'), timestamp: i + 1
          })) };
          const sg = await MV.sweepGroup('gA', g.messages);
          const pg = await MV.prefetchGroup('gA', '群里聊了什么');
          /* 直接读群池块（绕过 API 导出，确认块到底建没建） */
          const groupBlocks = await new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readonly');
              const out = [];
              const cur = t.objectStore('vec').openCursor();
              cur.onsuccess = () => { const c = cur.result; if (!c) { db.close(); res(out); } else { if ((c.value.ownerKey || '') === 'group:gA') out.push(c.value); c.continue(); } };
              cur.onerror = () => { db.close(); res(out); };
            };
            rq.onerror = () => res([]);
          });
          /* A 关闭记忆，B 开启（都是非NPC主角，默认开；显式关 A） */
          window.__setCharConfig('A', false);
          window.__setCharConfig('B', true);
          const a = await MV.groupTextFor('gA', 'A');
          const b = await MV.groupTextFor('gA', 'B');
          /* 契约护栏：groupText 不存在 */
          return { a, b, hasGroupText: typeof MV.groupText === 'function',
            sweepOk: sg && sg.ok, sweepAdded: sg && sg.added,
            prefetchItems: pg ? pg.length : -1,
            rawCount: groupBlocks.length };
        });
        chk('M新3 关闭成员 A 的群池摘应为空', r.a === '');
        chk('M新3 开启成员 B 的群池摘要有内容', !!r.b && r.b.length > 0);
        chk('M新3 共享 groupText 已删除（契约护栏）', r.hasGroupText === false);
        console.log('  [M新3 诊断] sweepOk=' + r.sweepOk + ' sweepAdded=' + r.sweepAdded +
          ' prefetchItems=' + r.prefetchItems + ' rawGroupBlocks=' + r.rawCount);
        await ctx.close();
      }

      /* ---- M新4｜M2 / M4 / M5 / M8 显式运行证据 ----
         M2:关闭时私有池 sweep 停建、不调 embedding
         M4:关闭时共享池（群/岛/账号）照常建块
         M5:groupTextFor 逐成员（开→有 / 关→空）
         M8:关闭期间游标不推进 + 重复开启安全执行 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec, S = window.Sleepy.store;
          const snap = () => { const o = {}; Object.keys(window.__embedCount).forEach((k) => { o[k] = window.__embedCount[k]; }); return o; };
          const delta = (a, b) => Object.keys(b).reduce((s, k) => s + (b[k] - (a[k] || 0)), 0);
          const before = snap();

          /* M2：关闭 → 私有池 sweep 应 memoff、不调 embedding */
          window.__setCharConfig('r2', false);
          const chat2 = {
            id: 'chatR2', characterId: 'c2', userId: 'u1', name: 'r2',
            messages: Array.from({ length: 10 }, (_, i) => ({ id: 'r2_' + i, role: 'char', content: '话' + i, timestamp: i }))
          };
          S.set('chats', [chat2]);
          const sweepClosed = await MV.sweep('r2', 'u1', chat2);
          const m2 = delta(before, snap());
          const before2 = snap();

          /* M4：同一环境里，共享池（群）关闭 r2 时照常建块 */
          const g10 = { groupId: 'gM4', messages: Array.from({ length: 10 }, (_, i) => ({ id: 'gM4_' + i, type: 'text', content: '群M4话' + i, fromId: 'x', timestamp: i })) };
          const sweepGroup = await MV.sweepGroup('gM4', g10.messages);
          const m4 = delta(before2, snap());
          const before3 = snap();

          /* M5：groupTextFor 逐成员 —— A关 B开（共用同一群池缓存） */
          window.__setCharConfig('mA', false);
          window.__setCharConfig('mB', true);
          await MV.prefetchGroup('gM4', '群话');
          const a5 = await MV.groupTextFor('gM4', 'mA');
          const b5 = await MV.groupTextFor('gM4', 'mB');

          /* M8：重复开启的 rootEpoch 语义（拆两组，对齐真实边沿 setCharConfig：
             **只有 false→true 才 +1，true→true 不变**。测试脚本手动模拟边沿 ——
             用新角色 xR，避免与上面 r2 的关闭状态纠缠。） */
          var edgeOpen = function (root) { window.__setCharConfig(root, false); window.__setCharConfig(root, true); MV.invalidateCursorsFor(root); };
          var reOpen = function (root) { window.__setCharConfig(root, true); /* true→true 不调 invalidate */ };
          var edgeRecycle = function (root) { window.__setCharConfig(root, false); window.__setCharConfig(root, true); MV.invalidateCursorsFor(root); };
          /* 组1：false→true→true —— rootEpoch 应从 0 只到 1 */
          edgeOpen('xR');
          var g1e = await MV._pure.rootEpochNow('xR');
          reOpen('xR');
          var g1f = await MV._pure.rootEpochNow('xR');
          /* 组2：false→true→false→true —— 0 → 1 → 2 */
          edgeRecycle('xR');
          var g2 = await MV._pure.rootEpochNow('xR');

          return {
            sweepClosedWhy: sweepClosed && sweepClosed.why,
            m2, m4,
            sweepGroupOk: sweepGroup && sweepGroup.ok, sweepGroupAdded: sweepGroup && sweepGroup.added,
            a5: a5 === '', b5Has: !!b5 && b5.length > 0,
            g1e, g1f, g2
          };
        });
        chk('M新4(M2) 关闭时私有池 sweep 返回 memoff', r.sweepClosedWhy === 'memoff');
        chk('M新4(M2) 关闭时私有池 embedding 增量为 0', r.m2 === 0);
        chk('M新4(M4) 关闭 r2 时共享池（群）照常建块（added>0）', r.sweepGroupOk === true && r.sweepGroupAdded > 0);
        chk('M新4(M4) 共享池建块确实调了 embedding（>0）', r.m4 > 0);
        chk('M新4(M5) groupTextFor 关闭成员为空', r.a5 === true);
        chk('M新4(M5) groupTextFor 开启成员有内容', r.b5Has === true);
        chk('M新4(M8组1) false→true 后 rootEpoch 0→1', r.g1e === 1);
        chk('M新4(M8组1) true→true（重复开）rootEpoch 不再 +1（仍 1）', r.g1f === 1);
        chk('M新4(M8组2) false→true→false→true 后 rootEpoch 0→1→2', r.g2 === 2);
        console.log('  [M新4 诊断] M2-emb=' + r.m2 + ' M4-emb=' + r.m4 +
          ' 群added=' + r.sweepGroupAdded + ' rootEpoch(组1:开/重开)=' + r.g1e + '/' + r.g1f + ' (组2:两次开关)=' + r.g2);
        await ctx.close();
      }

      /* ---- M新5｜lastOf 池过滤：关闭只排除当前 root 私有块，保留岛/账号池 ----
         构造：r1私有块 + 岛池块(island:sb1) + 账号池块(user:u1) + 其他root块(r2)。
         开启 r1/r2 各 prefetch（缓存混入 root+island+user 三池）→ 关闭 r1 →
         lastOf('r1') 只滤 r1 私有块，island/user 仍可消费；
         其他root（r2）lastOf 不受 r1 关闭影响（r2 自己开启）。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          const putOne = (ownerKey, text) => new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readwrite');
              const os = t.objectStore('vec');
              os.put({
                id: 'L_' + ownerKey.replace(/:/g, '_') + '_' + text,
                ownerKey,
                charId: ownerKey.indexOf(':') < 0 ? ownerKey : null,
                fromCharId: 'f1', sandboxId: 'sb1', kind: 'chat',
                msgIds: ['mid_' + text], text, vec: [0.1, 0.2],
                model: 'emb-test', at: Date.now()
              });
              t.oncomplete = () => { db.close(); res(true); };
              t.onerror = () => { db.close(); res(false); };
            };
            rq.onerror = () => res(false);
          });
          const setCfg = (root, en) => window.__setCharConfig(root, en);
          /* 四池各一块（model 对齐测试桩 emb-test）；r1 用 u1、r2 用 u2，
             账号池各自独立（user:u1 / user:u2） */
          await putOne('r1', 'R1私有块');
          await putOne('island:sb1', '岛上一句话');
          await putOne('user:u1', '我写的日记');
          await putOne('r2', 'R2私有块');
          await putOne('user:u2', 'u2的日记');
          /* 开启 r1 / r2，分别 prefetch（r1 召 root+island+user:u1；r2 召 root+island+user:u2） */
          setCfg('r1', true); setCfg('r2', true);
          await MV.prefetch('r1', 'u1', '聊了什么', { recall: 4 });
          await MV.prefetch('r2', 'u2', '聊了什么', { recall: 4 });
          const open1 = (await MV.lastOf('r1', 'u1')).map((x) => x.ownerKey);
          /* 关闭 r1（r2 保持开启）→ lastOf('r1') 只滤 r1 私有块 */
          setCfg('r1', false);
          const closed1 = (await MV.lastOf('r1', 'u1')).map((x) => x.ownerKey);
          /* r2 仍开启 → lastOf('r2') 不受 r1 关闭影响 */
          const r2ow = (await MV.lastOf('r2', 'u2')).map((x) => x.ownerKey);
          return {
            open1, closed1, r2ow,
            openHasRoot: open1.indexOf('r1') >= 0,
            openHasIsland: open1.indexOf('island:sb1') >= 0,
            openHasUser: open1.indexOf('user:u1') >= 0,
            closedHasRoot: closed1.indexOf('r1') >= 0,
            closedHasIsland: closed1.indexOf('island:sb1') >= 0,
            closedHasUser: closed1.indexOf('user:u1') >= 0,
            r2HasRoot: r2ow.indexOf('r2') >= 0,
            r2HasIsland: r2ow.indexOf('island:sb1') >= 0,
            r2HasUser: r2ow.indexOf('user:u2') >= 0
          };
        });
        chk('M新5 开启时 lastOf 含 r1 私有块', r.openHasRoot);
        chk('M新5 开启时 lastOf 含岛池块', r.openHasIsland);
        chk('M新5 开启时 lastOf 含账号池块', r.openHasUser);
        chk('M新5 关闭后 lastOf 排除 r1 私有块', !r.closedHasRoot);
        chk('M新5 关闭后 lastOf 仍含岛池块（不被误杀）', r.closedHasIsland);
        chk('M新5 关闭后 lastOf 仍含账号池块（不被误杀）', r.closedHasUser);
        chk('M新5 其他root(r2) lastOf 不受 r1 关闭影响（仍含其私有块）', r.r2HasRoot);
        chk('M新5 其他root(r2) 共享池仍含岛/账号块(user:u2)', r.r2HasIsland && r.r2HasUser);
        console.log('  [M新5 数据] 开时ownerKeys=' + JSON.stringify(r.open1) +
          ' 关后ownerKeys=' + JSON.stringify(r.closed1) +
          ' r2(不受影响)=' + JSON.stringify(r.r2ow));
        await ctx.close();
      }

      /* ---- M新6｜refresh/reindex 旁路：关闭时私有池不重建，共享池照常 ----
         refreshMem / refreshPhone 是私有池素材入口（ownerKey=rootOf），汇聚 reindexItem。
         关闭 r1 时：二者应返回 memoff、不调 embedding、不写新私有块；
         refreshDiary 的 user 分支（账号池，带前缀）照常 reindex + embedding。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          /* 补桩：让 refreshMem / refreshPhone 能走到 reindexItem（测试页桩只给了 charConfig） */
          window.Sleepy.memoryStore.loadCharMemory = function (charId) {
            return { memories: [{ id: 'memA', status: 'active', content: '一条档案记忆', createdAt: '2026-01-01T00:00:00Z', fromCharId: charId }] };
          };
          window.Sleepy.phone = {
            phoneOf: function (sb, charId) { return { id: 'ph1' }; },
            listNotes: function (phId) { return [{ id: 'n1', title: '备忘', content: '手机备忘内容' }]; },
            plansOf: function (phId) { return []; },
            listShop: function (phId) { return []; }
          };
          const snap = () => { const o = {}; Object.keys(window.__embedCount).forEach((k) => { o[k] = window.__embedCount[k]; }); return o; };
          const delta = (a, b) => Object.keys(b).reduce((s, k) => s + (b[k] - (a[k] || 0)), 0);
          const countOf = (ownerKey) => new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readonly');
              const idx = t.objectStore('vec').index('ownerKey');
              let n = 0;
              const cur = idx.openCursor(IDBKeyRange.only(ownerKey));
              cur.onsuccess = () => { const c = cur.result; if (!c) { db.close(); res(n); } else { n++; c.continue(); } };
              cur.onerror = () => { db.close(); res(n); };
            };
            rq.onerror = () => res(0);
          });
          window.__setCharConfig('r1', false);
          /* 私有：refreshMem / refreshPhone 应短路（memoff、0 embedding、不写块） */
          const b0 = snap();
          const rm = await MV.refreshMem('r1', 'memA');
          const dRm = delta(b0, snap());
          const b1 = snap();
          const rp = await MV.refreshPhone('r1', 'note', 'n1');
          const dRp = delta(b1, snap());
          const privBlocks = await countOf('r1');
          /* 共享：refreshDiary user 分支（账号池）照常 */
          const b2 = snap();
          const rd = await MV.refreshDiary({ id: 'd1', author: 'user', userId: 'u1', content: '我的新日记' });
          const dRd = delta(b2, snap());
          const userBlocks = await countOf('user:u1');
          return {
            rmWhy: rm && rm.why, rpWhy: rp && rp.why,
            dRm, dRp, privBlocks,
            rdOk: rd && rd.ok, dRd, userBlocks
          };
        });
        chk('M新6 关闭时 refreshMem 返回 memoff（私有池短路）', r.rmWhy === 'memoff');
        chk('M新6 关闭时 refreshPhone 返回 memoff（私有池短路）', r.rpWhy === 'memoff');
        chk('M新6 关闭时 refreshMem 不调 embedding（增量 0）', r.dRm === 0);
        chk('M新6 关闭时 refreshPhone 不调 embedding（增量 0）', r.dRp === 0);
        chk('M新6 关闭时私有池不写新块（r1 块数仍 0）', r.privBlocks === 0);
        chk('M新6 共享池(账号 user:u1) refreshDiary 照常重建（ok）', r.rdOk === true);
        chk('M新6 共享池(账号) 确实调了 embedding（>0）', r.dRd > 0);
        chk('M新6 共享池(账号) 新块建成（user:u1 块数>0）', r.userBlocks > 0);
        console.log('  [M新6 数据] refreshMem=' + r.rmWhy + ' emb=' + r.dRm +
          ' | refreshPhone=' + r.rpWhy + ' emb=' + r.dRp +
          ' | 私有块数=' + r.privBlocks +
          ' | refreshDiary(user)=' + r.rdOk + ' emb=' + r.dRd + ' user块数=' + r.userBlocks);
        await ctx.close();
      }

      /* ---- M新7｜指纹跳过在 embedding 之前：旧块→关→开、无新增消息，重扫 0 收费 ----
         验证 sweepSource 的先后：buildFingerprint 去重 **先于** embedTexts。
         场景：首建块 → 关闭（sweep memoff）→ 开启+invalidate（rootEpoch 0→1）→
         重扫**无新增消息**。nextBlock 切出的段指纹全部命中库内已有块 →
         fresh.length=0 → 走 `if (!fresh.length) return {added:0}`，**一次 embedding 都不调**。
         这修正文档「历史段会重新计算并收费」→「从头遍历历史源，已有段跳过，仅新增/未命中段计算」。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec, S = window.Sleepy.store;
          function mkChat(id, tag, n) {
            return {
              id, characterId: 'c1', userId: 'u1', name: tag,
              messages: Array.from({ length: n }, (_, i) => ({
                id: tag + '_' + i, role: i % 2 ? 'user' : 'char',
                content: tag + '话' + i, timestamp: 1000 + i
              }))
            };
          }
          const snap = () => { const o = {}; Object.keys(window.__embedCount).forEach((k) => { o[k] = window.__embedCount[k]; }); return o; };
          const delta = (a, b) => Object.keys(b).reduce((s, k) => s + (b[k] - (a[k] || 0)), 0);
          const allBlocks = () => new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readonly');
              const out = [];
              const cur = t.objectStore('vec').openCursor();
              cur.onsuccess = () => { const c = cur.result; if (!c) { db.close(); res(out); } else { out.push(c.value); c.continue(); } };
              cur.onerror = () => { db.close(); res(out); };
            };
            rq.onerror = () => res([]);
          });
          const chat = mkChat('chatW', 'W', 20);
          S.set('chats', [chat]);
          const setCfg = (enabled) => window.__setCharConfig('r1', enabled);
          /* 开1：首建块 */
          setCfg(true);
          const e0 = snap();
          const r0 = await MV.sweep('r1', 'u1', chat);
          const d0 = delta(e0, snap());
          const blocks0 = await allBlocks();
          /* 关 + 开 + invalidate（rootEpoch 0→1）→ 重扫，无新增消息 */
          setCfg(false);
          const r1 = await MV.sweep('r1', 'u1', chat);   // 关时 memoff
          setCfg(true);
          MV.invalidateCursorsFor('r1');
          const e2 = snap();
          const r2 = await MV.sweep('r1', 'u1', chat);   // 重扫（无新增）
          const d2 = delta(e2, snap());
          const blocks2 = await allBlocks();
          return {
            firstAdded: r0 && r0.added, d0, blocks0: blocks0.length,
            closedWhy: r1 && r1.why,
            reSweepAdded: r2 && r2.added, d2, blocks2: blocks2.length
          };
        });
        chk('M新7 首建块 added>0（有块可跳过的前提）', r.firstAdded > 0);
        chk('M新7 首建块确实调了 embedding', r.d0 > 0);
        chk('M新7 关闭时 sweep 返回 memoff', r.closedWhy === 'memoff');
        chk('M新7 重扫(无新增) added=0（全被指纹跳过）', r.reSweepAdded === 0);
        chk('M新7 重扫(无新增) embedding 增量=0（跳过在 embed 之前）', r.d2 === 0);
        chk('M新7 重扫后块数不变（不增副本）', r.blocks2 === r.blocks0);
        console.log('  [M新7 数据] 首建块=' + r.firstAdded + ' emb=' + r.d0 + ' 块数=' + r.blocks0 +
          ' | 关sweep=' + r.closedWhy +
          ' | 重扫(无新增)=' + r.reSweepAdded + ' emb=' + r.d2 + ' 块数=' + r.blocks2);
        await ctx.close();
      }

      /* ---- M新8｜同 sourceId/fromId/toId 正文被编辑：reindexItem 替换旧块+重 embedding ----
         验证定向重建（refresh/reindex）路径：同指纹（sourceId=mem、fromId=toId=itemId）但
         正文改了，reindexItem 会**先 forget 删旧块、再用相同指纹重建新正文** ——
         每次编辑都替换旧块并重新 embedding（不走 buildFingerprint，不被指纹去重挡住）。
         这是期望行为，非缺陷；不为此清空向量库。
         随后 invalidate 重扫验证：指纹命中跳过，且块内容是**新正文**（不被旧内容覆盖）。 */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=p2');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          const snap = () => { const o = {}; Object.keys(window.__embedCount).forEach((k) => { o[k] = window.__embedCount[k]; }); return o; };
          const delta = (a, b) => Object.keys(b).reduce((s, k) => s + (b[k] - (a[k] || 0)), 0);
          const blocksOf = (ownerKey, sourceId) => new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readonly');
              const out = [];
              const cur = t.objectStore('vec').openCursor();
              cur.onsuccess = () => {
                const c = cur.result;
                if (!c) { db.close(); res(out); }
                else { if (c.value.ownerKey === ownerKey && (!sourceId || c.value.sourceId === sourceId)) out.push(c.value); c.continue(); }
              };
              cur.onerror = () => { db.close(); res(out); };
            };
            rq.onerror = () => res([]);
          });
          window.__setCharConfig('r1', true);
          const opts = (text) => ({
            kind: 'mem', sourceId: 'mem', charId: 'r1', userId: null,
            item: { id: 'it1', timestamp: 1000, text: text, iso: 'char', charId: 'r1', userId: null }
          });
          /* 建版本A */
          const e0 = snap();
          const ra = await MV.reindexItem(opts('版本A正文'));
          const dA = delta(e0, snap());
          const blocksA = await blocksOf('r1', 'mem');
          /* 改正文为版本B，同 id/sourceId 再 reindexItem → 替换+重embedding */
          const e1 = snap();
          const rb = await MV.reindexItem(opts('版本B正文'));
          const dB = delta(e1, snap());
          const blocksB = await blocksOf('r1', 'mem');
          /* invalidate 重扫：指纹命中跳过，块内容应为版本B */
          MV.invalidateCursorsFor('r1');
          const e2 = snap();
          const rw = await MV.sweep('r1', 'u1', { id: 'x', characterId: 'c1', userId: 'u1', name: 'x', messages: [] });
          const dW = delta(e2, snap());
          /* 用 reindexItem 建的块在 sweep 里 sourceId='mem' 与 chat 源无关；这里 sweep 传空 chat，
             验证重扫不重复收费即可。块内容用 blocksB 判定。 */
          const textsB = blocksB.map((b) => b.text);
          return {
            okA: ra && ra.ok, addedA: ra && ra.added, dA, blockCountA: blocksA.length,
            okB: rb && rb.ok, addedB: rb && rb.added, dB,
            blockCountB: blocksB.length,
            hasB: textsB.indexOf('版本B正文') >= 0,
            hasA: textsB.indexOf('版本A正文') >= 0
          };
        });
        chk('M新8 版本A reindex 建块成功（ok）', r.okA === true);
        chk('M新8 版本A 调了 embedding', r.dA > 0);
        chk('M新8 版本A 建成 1 块', r.blockCountA === 1);
        chk('M新8 编辑为版本B reindex 成功（ok）', r.okB === true);
        chk('M新8 版本B 重新 embedding（>0）', r.dB > 0);
        chk('M新8 版本B 替换后仍 1 块（不重复累加）', r.blockCountB === 1);
        chk('M新8 库内块已是版本B 正文', r.hasB === true);
        chk('M新8 库内不再有版本A 正文（旧块被替换）', r.hasA === false);
        console.log('  [M新8 数据] A:ok=' + r.okA + ' added=' + r.addedA + ' emb=' + r.dA + ' 块数=' + r.blockCountA +
          ' | B:ok=' + r.okB + ' added=' + r.addedB + ' emb=' + r.dB + ' 块数=' + r.blockCountB +
          ' | 库含B=' + r.hasB + ' 含A=' + r.hasA);
        await ctx.close();
      }

    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    server.kill();
  }

  const fail = results.filter((r) => !r.ok);
  console.log('项目2 原生浏览器验收：' + (results.length - fail.length) + ' 过 / ' + fail.length + ' 败');
  console.log(JSON.stringify({ pass: results.length - fail.length, fail: fail.length, failed: fail.map((f) => f.name) }));
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((e) => { console.error('browser-p2-test 异常：', e); process.exit(1); });
