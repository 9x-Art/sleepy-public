/* ============================================================
   scripts/browser-idb-test.js — 项目 5 的**原生 IndexedDB**浏览器验收
   ------------------------------------------------------------
   环境层级：这是「原生浏览器」层 —— 真系统 Edge（headless、一次性
   隔离 profile）+ 真原生 IndexedDB + 生产源码原文（store.js /
   memory-vec.js 经同源 <script> 加载，不加壳）。上面还有两层：
     · smoke（无 IDB，纯桩/静态）
     · scripts/idb-upgrade-test.js（Node 内存 IDB 桩 =「桩环境行为测试」）
   三层各验各的，桩结果不替代原生结果。

   测试站点：本地 serve.js（默认 127.0.0.1:5199，避开 5173）+
   preview/idb-test/index.html（?case= 选场景）。preview/ 在 deploy.sh
   的排除清单里，不会上线。embedding 全程 mock，不产生真实费用。

   跑法（playwright-core 装在 managed workspace）：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-idb-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('browser-idb-test：找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-idb-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.IDB_TEST_PORT || 5199;
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

/* 在页面里等生产脚本注入完成（__loaded）或启动失败（__bootError） */
async function waitLoaded(page) {
  await page.waitForFunction(
    () => window.__loaded === true || !!window.__bootError,
    null, { timeout: 20000 });
  const err = await page.evaluate('window.__bootError || null');
  if (err) throw new Error('页面启动失败：' + err);
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  try {
    await waitServer();
    const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    try {
      /* ---- 1｜升级权威信号 + 全新不误报（原生 IDB，生产开库路径） ---- */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=upgrade');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          const version = await new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');   /* 不带版本：只探当前版本 */
            rq.onsuccess = () => { const v = rq.result.version; rq.result.close(); res(v); };
          });
          return {
            version,
            records: await MV.total(),
            state: MV.rebuildState(),
            avail: await MV.available()
          };
        });
        chk('原生1 库版本没升到 6', r.version === 6);
        chk('原生1 旧向量没按设计清空', r.records === 0);
        chk('原生1 重建提示没挂上（event.oldVersion 权威信号在生产路径失效）',
          !!r.state && r.state.state === 'needed' && r.state.via === 'idb' && r.state.fromVer === 5);
        chk('原生1 available 不是 true', r.avail === true);
        await ctx.close();
      }
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=fresh');
        await waitLoaded(page);
        const st = await page.evaluate('window.Sleepy.memoryVec.rebuildState()');
        chk('原生1b 全新建库误报了旧库重建', st === null);
        await ctx.close();
      }

      /* ---- 2｜重建断点续扫：部分成功后失败 → 重试不重算、补完、清提示 ---- */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=resume');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec, S = window.Sleepy.store;
          const mkChat = (id, tag) => ({
            id, characterId: 'c1', userId: 'u1', name: tag,
            messages: Array.from({ length: 20 }, (_, i) => ({
              id: tag + '_' + i, role: i % 2 ? 'user' : 'char',
              content: tag + '话' + i, timestamp: 1000 + i
            }))
          });
          S.set('chats', [mkChat('chatA', 'A'), mkChat('chatB', 'B')]);
          S.set('vecRebuild', { state: 'needed', at: Date.now() - 1000 });
          window.__allowB = false;
          const r1 = await MV.rebuildIndex();
          const after1 = await MV.total();
          const countFor = (tag) => Object.keys(window.__embedCount)
            .filter((t) => t.indexOf(tag + '话') >= 0)
            .reduce((s, t) => s + window.__embedCount[t], 0);
          const aRun1 = countFor('A');
          const bRun1 = countFor('B');                     /* 重试前快照 */
          window.__allowB = true;                       /* 用户修好接口 → 重试 */
          const r2 = await MV.rebuildIndex();
          return {
            r1ok: r1.ok === true, failed1: !r1.ok,
            after1, aRun1, bRun1,
            r2ok: r2.ok === true,
            flagCleared: MV.rebuildState() === null,
            total: await MV.total(),
            aRun2: countFor('A'), bRun2: countFor('B')
          };
        });
        chk('原生2 第一轮没有如实失败', r.failed1 && !r.r1ok);
        chk('原生2 第一轮 A 场块没入库', r.after1 > 0);
        chk('原生2 第一轮 A 场文本没嵌入', r.aRun1 > 0);
        chk('原生2 第一轮 B 场文本被嵌入了（应被失败挡住）', r.bRun1 === 0);
        chk('原生2 重试没走完', r.r2ok);
        chk('原生2 重试成功后提示没清掉', r.flagCleared);
        chk('原生2 最终块数不对（A 两块 + B 两块）', r.total === r.after1 + 2);
        chk('原生2 已完成的 A 场块被重复计算了', r.aRun2 === r.aRun1);
        chk('原生2 剩余的 B 场块没补完', r.bRun2 > 0);
        await ctx.close();
      }

      /* ---- 3｜三维 forget（原生 IDB，生产 forget 路径） ---- */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=forget');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          const names = () => new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readonly');
              const out = [];
              const cur = t.objectStore('vec').openCursor();
              cur.onsuccess = () => { const c = cur.result; if (!c) { db.close(); res(out); } else { out.push(c.value.id); c.continue(); } };
            };
          });
          const del1 = await MV.forget({ charId: 'r1', fromCharId: 'fA', sandboxId: 'sb1' });
          const after1 = await names();
          /* 删别岛的块要在那个岛的上下文里操作（生产语义：scanOwner 按当前岛
             过滤——移出岛动作本来就发生在那座岛上）。切到岛 2 再删。 */
          window.Sleepy.core.scopeId = function () { return 'sb2'; };
          const del2 = await MV.forget({ charId: 'r1', fromCharId: 'fA', sandboxId: 'sb2' });
          const after2 = await names();
          return { del1, after1, del2, after2 };
        });
        chk('原生3 删 A+岛1 没有恰删 1 块', r.del1 === 1);
        chk('原生3 B脸/岛2/岛池的块没留住：' + JSON.stringify(r.after1),
          JSON.stringify(r.after1.sort()) === JSON.stringify(['b2', 'b3', 'b4']));
        chk('原生3 删 A+岛2 没有恰删 1 块', r.del2 === 1);
        chk('原生3 最终存量不对：' + JSON.stringify(r.after2),
          JSON.stringify(r.after2.sort()) === JSON.stringify(['b2', 'b4']));
        await ctx.close();
      }

      /* ---- 项目3｜解散群 purgeGroup（原生 IDB）
         失败注入 → 保留主表可重试；重试成功 → 全清 + 隔离对照 + tombstone；api-missing 门禁。 ---- */
      {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(PAGE + '?case=purge');
        await waitLoaded(page);
        const r = await page.evaluate(async () => {
          const MV = window.Sleepy.memoryVec, GS = window.Sleepy.groupStore, S = window.Sleepy.store;
          const ids = () => new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => {
              const db = rq.result;
              const t = db.transaction('vec', 'readonly');
              const out = [];
              const cur = t.objectStore('vec').openCursor();
              cur.onsuccess = () => { const c = cur.result; if (!c) { db.close(); res(out); } else { out.push(c.value.id); c.continue(); } };
            };
          });
          const has = (arr, id) => arr.indexOf(id) >= 0;
          const g1blocks = async () => (await ids()).filter((x) => /^ga\d$/.test(x)).length;
          const base = {
            g1: await g1blocks(),
            g2: (await ids()).filter((x) => x === 'gb1').length,
            isl: (await ids()).filter((x) => x === 'isl1').length,
            role: (await ids()).filter((x) => x === 'rblk').length,
            acc: (await ids()).filter((x) => x === 'ublk').length
          };
          /* 1) 失败注入：forgetGroup 改为 reject → purgeGroup 必须保留主表 */
          const savedFG = MV.forgetGroup;
          MV.forgetGroup = () => Promise.reject(new Error('injected-vector-down'));
          const fail = await GS.purgeGroup('gid1');
          MV.forgetGroup = savedFG;
          const afterFail = {
            ok: fail && fail.ok === false, why: fail && fail.why,
            gid1exists: !!GS.findGroup('gid1'),
            g1: await g1blocks(),
            pending: S.get('groupPending:gid1') != null,
            inner: S.get('groupInner:gid1') != null,
            cursor: S.get('sumCursor:g:gid1') != null,
            offline: (S.get('groupOfflineSessions') || []).some((x) => x.groupId === 'gid1')
          };
          /* 2) 修复后重试成功：真 forgetGroup → 全清 + 隔离 */
          const okr = await GS.purgeGroup('gid1');
          const idsOk = await ids();
          const afterOk = {
            ok: okr && okr.ok === true,
            gid1exists: !!GS.findGroup('gid1'),
            g1: (await ids()).filter((x) => /^ga\d$/.test(x)).length,
            g2: idsOk.filter((x) => x === 'gb1').length,
            isl: idsOk.filter((x) => x === 'isl1').length,
            role: idsOk.filter((x) => x === 'rblk').length,
            acc: idsOk.filter((x) => x === 'ublk').length,
            pending: S.get('groupPending:gid1') == null,
            inner: S.get('groupInner:gid1') == null,
            cursor: S.get('sumCursor:g:gid1') == null,
            gid1offline: (S.get('groupOfflineSessions') || []).some((x) => x.groupId === 'gid1'),
            gid1handoff: (S.get('offlineHandoffs') || []).some((x) => x.groupId === 'gid1'),
            gid1members: (S.get('groupMembers') || []).some((x) => x.groupId === 'gid1'),
            gid1msgs: (S.get('groupMessages') || []).some((x) => x.groupId === 'gid1'),
            gid2group: !!GS.findGroup('gid2'),
            gid2members: (S.get('groupMembers') || []).some((x) => x.groupId === 'gid2'),
            gid2msgs: (S.get('groupMessages') || []).some((x) => x.groupId === 'gid2'),
            gid2offline: (S.get('groupOfflineSessions') || []).some((x) => x.groupId === 'gid2'),
            gid2handoff: (S.get('offlineHandoffs') || []).some((x) => x.groupId === 'gid2')
          };
          /* 3) api-missing 门禁：删 forgetGroup → 必须失败保留主表 */
          delete MV.forgetGroup;
          const miss = await GS.purgeGroup('gid2');
          MV.forgetGroup = savedFG;
          const afterMiss = { ok: miss && miss.ok === false, why: miss && miss.why, gid2exists: !!GS.findGroup('gid2') };
          return { base, afterFail, afterOk, afterMiss };
        });
        chk('原生P3 基线：目标群2块 / 参照群1块 / 岛角色账号各1块',
          r.base.g1 === 2 && r.base.g2 === 1 && r.base.isl === 1 && r.base.role === 1 && r.base.acc === 1);
        chk('原生P3 失败注入：purgeGroup 返回 ok:false', r.afterFail.ok);
        chk('原生P3 失败注入：why = memory-vector-failed', r.afterFail.why === 'memory-vector-failed');
        chk('原生P3 失败注入：主表保留（gid1 仍在）', r.afterFail.gid1exists === true);
        chk('原生P3 失败注入：向量块未删', r.afterFail.g1 === 2);
        chk('原生P3 失败注入：派生键仍在（可重试）', r.afterFail.pending && r.afterFail.inner && r.afterFail.cursor);
        chk('原生P3 失败注入：线下行仍在', r.afterFail.offline === true);
        chk('原生P3 重试成功：返回 ok:true', r.afterOk.ok);
        chk('原生P3 重试成功：gid1 主表清', !r.afterOk.gid1exists);
        chk('原生P3 重试成功：gid1 向量块清空', r.afterOk.g1 === 0);
        chk('原生P3 重试成功：gid1 派生三键清', r.afterOk.pending && r.afterOk.inner && r.afterOk.cursor);
        chk('原生P3 重试成功：gid1 线下两数组清（tombstone→ended→删）', !r.afterOk.gid1offline && !r.afterOk.gid1handoff);
        chk('原生P3 重试成功：gid1 成员/消息清', !r.afterOk.gid1members && !r.afterOk.gid1msgs);
        chk('原生P3 隔离：参照群 gid2 主表保留', r.afterOk.gid2group && r.afterOk.gid2members && r.afterOk.gid2msgs);
        chk('原生P3 隔离：参照群 gid2 向量块保留', r.afterOk.g2 === 1);
        chk('原生P3 隔离：参照群 gid2 线下保留', r.afterOk.gid2offline && r.afterOk.gid2handoff);
        chk('原生P3 隔离：岛/角色/账号池全保留', r.afterOk.isl === 1 && r.afterOk.role === 1 && r.afterOk.acc === 1);
        chk('原生P3 api缺失：gid2 返回 ok:false', r.afterMiss.ok);
        chk('原生P3 api缺失：why = api-missing', r.afterMiss.why === 'memory-vector-unavailable/api-missing');
        chk('原生P3 api缺失：主表保留', r.afterMiss.gid2exists === true);
        await ctx.close();
      }

      /* ---- 项目4｜向量删除出口（原生 IDB）
         forgetSandbox / forgetCharSet / forgetUser —— 真块 + 隔离 + 跨岛保留。
         core 的 purge 门禁 / 跨岛守卫 / 默认我保护已在 smoke 的 P4-M1~M11 全覆盖，
         这里只验**向量块的精确命中**（smoke 无 IDB 验不了）。
         ?case=p4 种子见 preview/idb-test/index.html（含大号 rA、皮套 fA1/fA2、
         NPC nA1/nA2、皮套子NPC snA1、马甲 uA，跨岛块 b1/b2/b3）。
         注意：每个出口都对着**全新种子**各跑一次（重载 ?case=p4 会重布置 IDB）。 ---- */
      {
        /* 取当前 IDB 里的块 id 集合 */
        const collect = (page) => page.evaluate(() => new Promise((res) => {
          const rq = indexedDB.open('sleepy-vec');
          rq.onsuccess = () => {
            const db = rq.result;
            const t = db.transaction('vec', 'readonly');
            const out = [];
            const cur = t.objectStore('vec').openCursor();
            cur.onsuccess = () => { const c = cur.result; if (!c) { db.close(); res(out); } else { out.push(c.value.id); c.continue(); } };
          };
        }));
        const MV = () => 'window.Sleepy.memoryVec';
        const ALL = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'b1', 'b2', 'b3', 'b4'].join(',');
        const has = (ids, id) => ids.indexOf(id) >= 0;
        const inA = (ids) => ids.split(',').filter((x) => /^a\d$/.test(x));
        const fresh = async (browser, page) => { await page.goto(PAGE + '?case=p4'); await waitLoaded(page); };

        /* 1) forgetSandbox(sbA)：整岛清（四类池一起），sbB 全留 */
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await fresh(browser, page);
          const base = (await collect(page)).sort().join(',');
          const n0 = await page.evaluate(() => window.Sleepy.memoryVec.forgetSandbox({ sandboxId: 'sbA' }));
          const afterSb = (await collect(page)).sort().join(',');
          chk('原生P4 基线：11 块全部入库', base === ALL);
          chk('原生P4 拆岛：forgetSandbox 清 7 块', n0 === 7);
          chk('原生P4 拆岛：sbA 全清（a1..a7 无）', inA(afterSb).length === 0);
          chk('原生P4 拆岛：sbB 完整（b1..b4 都在）', afterSb === 'b1,b2,b3,b4');
          await ctx.close();
        }
        /* 2) forgetCharSet({charIds:[nA1]},sbA)：删单 NPC —— 只清 nA1，同 root 全留 */
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await fresh(browser, page);
          const n = await page.evaluate(() => window.Sleepy.memoryVec.forgetCharSet({ charIds: ['nA1'], sandboxId: 'sbA' }));
          const after = (await collect(page)).sort().join(',');
          chk('原生P4 删NPC：forgetCharSet 清 1 块（nA1）', n === 1);
          chk('原生P4 删NPC：nA1 的块清（a4 无）', !has(after, 'a4'));
          chk('原生P4 删NPC：同root大号块留（a1 在）', has(after, 'a1'));
          chk('原生P4 删NPC：同root皮套块留（a2/a3 在）', has(after, 'a2') && has(after, 'a3'));
          chk('原生P4 删NPC：同root别的NPC留（a5 在）', has(after, 'a5'));
          chk('原生P4 删NPC：皮套子NPC留（a6 在）', has(after, 'a6'));
          chk('原生P4 删NPC：nA1 的跨岛块留（b3 在）', has(after, 'b3'));
          chk('原生P4 删NPC：仅 a4 被删', after === 'a1,a2,a3,a5,a6,a7,b1,b2,b3,b4');
          await ctx.close();
        }
        /* 3) forgetCharSet({charIds:[fA1,snA1]},sbA)：删皮套 + 其子NPC —— 一起清，同 root 别的留 */
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await fresh(browser, page);
          const n = await page.evaluate(() => window.Sleepy.memoryVec.forgetCharSet({ charIds: ['fA1', 'snA1'], sandboxId: 'sbA' }));
          const after = (await collect(page)).sort().join(',');
          chk('原生P4 删皮套+子NPC：forgetCharSet 清 2 块（fA1+snA1）', n === 2);
          chk('原生P4 删皮套+子NPC：皮套块清（a2 无）', !has(after, 'a2'));
          chk('原生P4 删皮套+子NPC：子NPC块清（a6 无）', !has(after, 'a6'));
          chk('原生P4 删皮套+子NPC：大号块留（a1 在）', has(after, 'a1'));
          chk('原生P4 删皮套+子NPC：同root别的皮套留（a3 在）', has(after, 'a3'));
          chk('原生P4 删皮套+子NPC：别的NPC留（a4/a5 在）', has(after, 'a4') && has(after, 'a5'));
          chk('原生P4 删皮套+子NPC：fA1 跨岛块留（b1 在）', has(after, 'b1'));
          chk('原生P4 删皮套+子NPC：仅 a2/a6 被删', after === 'a1,a3,a4,a5,a7,b1,b2,b3,b4');
          await ctx.close();
        }
        /* 4) forgetCharSet({charIds:[rA,fA1,fA2,nA1,nA2,snA1]},sbA)：删大号+全部皮套+全部子NPC */
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await fresh(browser, page);
          const n = await page.evaluate(() => window.Sleepy.memoryVec.forgetCharSet({ charIds: ['rA', 'fA1', 'fA2', 'nA1', 'nA2', 'snA1'], sandboxId: 'sbA' }));
          const after = (await collect(page)).sort().join(',');
          chk('原生P4 删大号：forgetCharSet 清 6 块（大号+皮套+子NPC）', n === 6);
          chk('原生P4 删大号：大号/皮套/子NPC 在 A 全清（a1..a6 无）',
            !has(after, 'a1') && !has(after, 'a2') && !has(after, 'a3') &&
            !has(after, 'a4') && !has(after, 'a5') && !has(after, 'a6'));
          chk('原生P4 删大号：马甲日记留（a7 在）', has(after, 'a7'));
          chk('原生P4 删大号：别岛同root块全留（b1/b2/b3 在）', has(after, 'b1') && has(after, 'b2') && has(after, 'b3'));
          chk('原生P4 删大号：仅 a1..a6 被删', after === 'a7,b1,b2,b3,b4');
          await ctx.close();
        }
        /* 5) forgetCharSet({charIds:['ghostNpc']},sbA)：空 NPC / 无命中 → resolve 0 */
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await fresh(browser, page);
          const n = await page.evaluate(() => window.Sleepy.memoryVec.forgetCharSet({ charIds: ['ghostNpc'], sandboxId: 'sbA' }));
          const after = (await collect(page)).sort().join(',');
          chk('原生P4 空NPC：forgetCharSet resolve 0', n === 0);
          chk('原生P4 空NPC：11 块全留', after === ALL);
          await ctx.close();
        }
        /* 6) forgetUser(uA,sbA)：清 uA 在 sbA 的日记，别岛同 uid 保留 */
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await fresh(browser, page);
          const n = await page.evaluate(() => window.Sleepy.memoryVec.forgetUser({ userId: 'uA', sandboxId: 'sbA' }));
          const after = (await collect(page)).sort().join(',');
          chk('原生P4 删马甲：forgetUser 只清 uA 在 A 的 1 块', n === 1);
          chk('原生P4 删马甲：uA 日记清（a7 无）', !has(after, 'a7'));
          chk('原生P4 删马甲：别岛 uB 留（b4 在）', has(after, 'b4'));
          chk('原生P4 删马甲：仅 a7 被删', after === 'a1,a2,a3,a4,a5,a6,b1,b2,b3,b4');
          await ctx.close();
        }
      }

      /* ---- 4｜两标签页升级阻塞：旧连接关闭后继续升级、状态可恢复 ----
         ⚠️ 原生实测（Edge）：被阻塞时 onblocked 并未在 8s 内触发 ——
         生产 open() 表现为**挂起**（不报「占着」也不放行），旧连接一关，
         升级自动继续完成。这与施工卡 B4-b 预期的「弹占着提示」有出入，
         如实记录；升级由**先发起请求的页**完成，等待页重载后才能看到提示
         （store 的内存缓存语义，与生产一致）。 */
      {
        const ctx = await browser.newContext();
        const holder = await ctx.newPage();
        await holder.goto(PAGE + '?case=hold');
        await holder.waitForFunction(() => !!window.__hold && window.__loaded === true, null, { timeout: 20000 });
        const upg = await ctx.newPage();
        await upg.goto(PAGE + '?case=upgrade2');
        await waitLoaded(upg);
        const blocked = await upg.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          const avail = await Promise.race([
            MV.available(),
            new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000))
          ]);
          return { avail, flag: MV.rebuildState() };
        });
        chk('原生4 旧连接占着时升级竟然放行了（available 返回 true）', blocked.avail !== true);
        chk('原生4 被阻塞期间不该挂重建提示（升级还没发生）', blocked.flag === null);
        await holder.evaluate('window.__hold.close()');     /* 旧标签页释放连接 */
        /* 升级在旧连接关闭后自动继续：轮询等版本到 6 */
        const version6 = await upg.waitForFunction(async () => {
          const v = await new Promise((res) => {
            const rq = indexedDB.open('sleepy-vec');
            rq.onsuccess = () => { const x = rq.result.version; rq.result.close(); res(x); };
          });
          return v === 6;
        }, null, { timeout: 20000, polling: 300 });
        chk('原生4 旧连接关闭后没有继续升级', !!version6);
        /* 等待页重载到**中性场景**（pre 不清任何东西）=「页面状态可恢复」：
            重载后能看到重建提示、旧块已清 */
        await upg.goto(PAGE + '?case=plain');
        await waitLoaded(upg);
        const resumed = await upg.evaluate(async () => {
          const MV = window.Sleepy.memoryVec;
          return { ok: await MV.available(), state: MV.rebuildState(), records: await MV.total() };
        });
        chk('原生4 恢复后 available 不是 true', resumed.ok === true);
        chk('原生4 重载后重建提示没挂上（升级完成的页写入了 via:idb，重载后应可见）',
          !!resumed.state && resumed.state.state === 'needed' && resumed.state.via === 'idb');
        chk('原生4 恢复后旧块没按设计清空', resumed.records === 0);
        await ctx.close();
      }
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    server.kill();
  }

  const fail = results.filter((r) => !r.ok);
  console.log('原生浏览器验收：' + (results.length - fail.length) + ' 过 / ' + fail.length + ' 败');
  console.log(JSON.stringify({ pass: results.length - fail.length, fail: fail.length, failed: fail.map((f) => f.name) }));
  /* 不用 process.exit：Windows 管道下它会丢掉未刷出的输出缓冲。
     用 exitCode + 自然退出（浏览器已关、服务子进程不挡事件循环）。 */
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((e) => { console.error('browser-idb-test 异常：', e); process.exit(1); });
