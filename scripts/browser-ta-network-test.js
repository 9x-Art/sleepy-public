/* ============================================================
   scripts/browser-ta-network-test.js — ta 关系网 v1 真机行为验收
   ------------------------------------------------------------
   复用 browser-we-test.js 的隔离设施：真系统 Edge（headless、一次性
   profile）+ 生产源码原文（加载**完整生产 app** /index.html）。

   为什么必须上真浏览器：关系网页的证据有三类桩里拿不到 ——
     · 真布局（getBBox / getBoundingClientRect）→ 触控尺寸与横向溢出；
     · 真计算样式（getComputedStyle 的 fill/stroke）→ 四主题可辨识；
     · 真指针（mouse.click 打在透明命中区上）→ 节点/边的选中详情。
   桩里 addEventListener 只记录不分发，点不出这些。

   跑法：
     NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules \
       node scripts/browser-ta-network-test.js
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pw;
try { pw = require('playwright-core'); } catch (e) {
  console.error('browser-ta-network-test：找不到 playwright-core —— 用 managed node workspace 跑：');
  console.error('  NODE_PATH=C:/Users/wumei/.workbuddy/binaries/node/workspace/node_modules node scripts/browser-ta-network-test.js');
  process.exit(2);
}
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.TAN_TEST_PORT || 5207;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOT = path.join(ROOT, 'preview/phone-test');

const results = [];
function chk(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
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
    return !!(S && S.nav && S.core && S.core.activeSandbox && S.taNetwork && S.nav.open);
  }, null, { timeout: 20000 });
  await sleep(600);
  /* 无头会冻住定时器，靠截图驱动一轮 */
  await page.screenshot({ path: path.join(SHOT, 'tan-boot.png') }).catch(() => {});
  return sleepyErrs;
}

/* 在页面里造世界：一座群岛（两个大号 + 一个皮套 + 两个 NPC）+ 一个马甲。
   返回 id 与"私有标记"，后面断言靠标记字符串而不是靠 id 猜。 */
function seed(page, name) {
  return page.evaluate((nm) => {
    const S = window.Sleepy;
    const mk = 'tn' + Math.random().toString(36).slice(2, 6);
    const m1 = S.core.upsertChar({ name: nm + '甲', kind: 'main' }).id;
    const m2 = S.core.upsertChar({ name: nm + '乙', kind: 'main' }).id;
    const sub = S.core.upsertChar({ name: nm + '皮套', kind: 'sub', parentId: m1 }).id;
    const u = S.core.upsertUser({ name: nm + '我' }).id;
    const sb = S.core.createSandbox('archipelago', nm + '岛');
    const set = S.core.setSandboxChars(sb.id, [m1, m2]);
    if (!set || set.ok !== true) throw new Error('建岛失败：' + JSON.stringify(set));
    S.core.setSandboxMasks(sb.id, [u]);
    /* 老存档式地把皮套混进名册：selector 必须按 main 口径滤掉 */
    const list = S.store.get('sandboxes');
    list.forEach((s) => { if (s.id === sb.id) s.charIds = s.charIds.concat([sub]); });
    S.store.set('sandboxes', list);

    const npcOk = S.core.upsertChar({
      name: nm + '店长', kind: 'npc', parentType: 'sandbox', parentId: sb.id, sandboxId: sb.id
    }).id;
    S.core.upsertChar({
      name: nm + '不该出现的', kind: 'npc', parentType: 'sandbox', parentId: sb.id,
      sandboxId: sb.id, knownBy: [m2]
    });

    S.core.setActiveSandbox(sb.id);
    S.core.switchTo(m1, u);

    /* 关系依据：中心×我 有 relation 文本 → 一条 link 边；甲×乙 charRel=known → 一条 charRel 边 */
    S.core.setRelation(m1, u, nm + '的老朋友', sb.id);
    const pk = m1 < m2 ? m1 + '|' + m2 : m2 + '|' + m1;
    S.store.set('charRel:' + sb.id, Object.assign({}, S.store.get('charRel:' + sb.id) || {}, { [pk]: 'known' }));

    /* 近况：公开一条 + 私密一条（私密绝不能上屏） */
    const SECRET = nm + '私密近况';
    S.momentsTab.add({ text: nm + '公开近况', characterId: m1, name: nm + '甲', at: Date.now() - 1000 });
    S.momentsTab.add({ text: SECRET, characterId: m1, name: nm + '甲', at: Date.now(), privacy: 'self' });

    return {
      mk, sb: sb.id, m1, m2, sub, u, npcOk,
      hidden: nm + '不该出现的',
      secret: SECRET,
      label: nm + '的老朋友',
      hiddenNpc: nm + '不该出现的'
    };
  }, name);
}

const pageSel = '.page[data-page="ta-network"]';
function pageText(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent || '' : '';
  }, pageSel);
}
/* 把 viewBox 坐标换成页面坐标再点 —— 透明命中区只有 getBBox 才知道在哪 */
async function clickVB(page, vx, vy) {
  const pt = await page.evaluate(([sel, x, y]) => {
    const svg = document.querySelector(sel + ' .tan-svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const k = r.width / 360;
    return { x: r.left + x * k, y: r.top + y * k };
  }, [pageSel, vx, vy]);
  if (!pt) throw new Error('拿不到 SVG 的屏幕坐标');
  await page.mouse.click(pt.x, pt.y);
  await sleep(160);
}

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), '--port=' + PORT], {
    cwd: ROOT, stdio: 'ignore'
  });
  let browser;
  try {
    await waitServer();
    browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();

    await page.goto(BASE + '/index.html?splash=0&_cb=' + Date.now(), { waitUntil: 'load' });
    let sleepyErrs = await waitApp(page);

    const W = await seed(page, '关系网甲');
    const errsBefore = sleepyErrs.length;

    /* ---------------- N1 打开：默认图视图 ---------------- */
    await page.evaluate(() => window.Sleepy.nav.open('ta-network', {}));
    await sleep(400);
    await page.screenshot({ path: path.join(SHOT, 'tan-graph.png') });

    const expect = await page.evaluate((sb) => {
      const S = window.Sleepy;
      const r = S.taNetwork.build({ sbId: sb });
      return {
        nodes: r.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })),
        edges: r.edges.map((e) => ({ label: e.label, kind: e.kind })),
        graphMax: S.taNetwork.GRAPH_MAX
      };
    }, W.sb);

    const n1 = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return {
        exists: !!el,
        svg: !!document.querySelector(sel + ' .tan-svg'),
        groups: document.querySelectorAll(sel + ' .tan-node-g').length,
        hits: document.querySelectorAll(sel + ' .tan-hit').length,
        segs: Array.from(document.querySelectorAll(sel + ' .iol-seg-btn')).map((b) => b.textContent)
      };
    }, pageSel);

    chk('N1 nav.open(ta-network) 打开、默认图视图、无 [Sleepy] 报错',
      n1.exists && n1.svg && n1.groups > 0 && sleepyErrs.length === errsBefore,
      'groups=' + n1.groups + ' errs=' + JSON.stringify(sleepyErrs.slice(errsBefore)));
    chk('N1b 分段控件是「关系图 / 列表」两个',
      n1.segs.length === 2 && n1.segs[0] === '关系图' && n1.segs[1] === '列表',
      JSON.stringify(n1.segs));
    const wantShown = Math.min(expect.nodes.length, expect.graphMax);
    chk('N2 图上节点数 = 中心 1 + selector 前 N（' + wantShown + '）',
      n1.groups === 1 + wantShown && n1.hits === n1.groups,
      'groups=' + n1.groups + ' 期望=' + (1 + wantShown));
    chk('N2b 皮套没进图（selector 节点里没有 sub）',
      expect.nodes.every((n) => n.id !== W.sub),
      JSON.stringify(expect.nodes.map((n) => n.name)));

    /* ---------------- N3 节点文字不越界（不遮挡） ----------------
       限度按圆的直径给：环上圆 r=24 → 直径 48，留 2 单位余量 → 46；
       中心圆 r=30 → 直径 60 → 58。取错了会误报（中心本来就放得下更多字）。 */
    async function fitReport() {
      return page.evaluate((sel) => {
        const bad = [];
        document.querySelectorAll(sel + ' .tan-node-g').forEach((g) => {
          const isCenter = g.classList.contains('is-center');
          const lim = isCenter ? 58 : 46;
          const t = g.querySelector('.tan-n-t');
          if (t) {
            const b = t.getBBox();
            if (b.width > lim || b.height > 18) {
              bad.push((isCenter ? '中心名 ' : '名字 ') + t.textContent +
                ' w=' + b.width.toFixed(1) + ' 限=' + lim);
            }
          }
          const lb = g.querySelector('.tan-n-lb');
          if (lb) {
            const b = lb.getBBox();
            if (b.width > 100) bad.push('标签 ' + lb.textContent + ' w=' + b.width.toFixed(1));
          }
        });
        return bad;
      }, pageSel);
    }
    const textFit = await fitReport();
    /* 反向断言：边中点的关系原文**不许回来** —— v1 星形拓扑里它和
       节点圆下的标签必然是同一句话、且位置几乎重合（真机截图叠字）。
       节点文字两两不相交的检查顺便把「不遮挡文字」这条红线锁住。 */
    const overlap = await page.evaluate((sel) => {
      const boxes = [];
      document.querySelectorAll(sel + ' .tan-node-g').forEach((g) => {
        ['.tan-n-t', '.tan-n-lb'].forEach((c) => {
          const t = g.querySelector(c);
          if (t) boxes.push({ cls: c, tx: t.textContent, b: t.getBBox() });
        });
      });
      const hit = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].b, b = boxes[j].b;
          const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (ix > 1 && iy > 1) {
            hit.push(boxes[i].tx + ' × ' + boxes[j].tx + ' (' + ix.toFixed(0) + '×' + iy.toFixed(0) + ')');
          }
        }
      }
      return {
        edgeText: document.querySelectorAll(sel + ' .tan-edge-t').length,
        hit
      };
    }, pageSel);
    chk('N3 节点名字限制在圆内、标签不越界、文字两两不遮挡、边中点无重复文案',
      textFit.length === 0 && overlap.edgeText === 0 && overlap.hit.length === 0,
      textFit.join(' / ') + ' edgeText=' + overlap.edgeText + ' 重叠=' + JSON.stringify(overlap.hit));

    /* ---------------- N4 触控命中区 ≥44px ---------------- */
    const hitBox = await page.evaluate((sel) => {
      const out = [];
      document.querySelectorAll(sel + ' .tan-hit').forEach((h) => {
        const r = h.getBoundingClientRect();
        out.push({ w: Math.round(r.width), h: Math.round(r.height) });
      });
      return out;
    }, pageSel);
    chk('N4 节点透明命中区 ≥44×44px',
      hitBox.length > 0 && hitBox.every((b) => b.w >= 44 && b.h >= 44),
      JSON.stringify(hitBox));

    /* ---------------- N5 没有文档级横向滚动 ---------------- */
    async function overflow() {
      return page.evaluate((sel) => {
        const de = document.documentElement;
        const g = document.querySelector(sel + ' .tan-graph');
        const svg = document.querySelector(sel + ' .tan-svg');
        return {
          doc: de.scrollWidth - de.clientWidth,
          graph: g ? g.scrollWidth - g.clientWidth : -1,
          svgW: svg ? Math.round(svg.getBoundingClientRect().width) : -1,
          boxW: g ? Math.round(g.getBoundingClientRect().width) : -1
        };
      }, pageSel);
    }
    const ov1 = await overflow();
    chk('N5 无文档级横向溢出，SVG 不超出容器',
      ov1.doc <= 1 && ov1.graph <= 1 && ov1.svgW <= ov1.boxW + 1,
      JSON.stringify(ov1));

    /* ---------------- N6 点节点 → 详情 ---------------- */
    const pos = await page.evaluate((sel) => {
      const out = [];
      document.querySelectorAll(sel + ' .tan-node-g').forEach((g) => {
        const c = g.querySelector('circle');
        out.push({
          cx: +c.getAttribute('cx'), cy: +c.getAttribute('cy'),
          center: g.classList.contains('is-center')
        });
      });
      return out;
    }, pageSel);
    const ring = pos.filter((p) => !p.center)[0];
    const ctr = pos.filter((p) => p.center)[0];
    if (!ctr) throw new Error('图上没有中心节点（is-center）');
    await clickVB(page, ctr.cx, ctr.cy);                /* 中心节点 */
    const centerDetail = await page.evaluate((sel) => {
      const d = document.querySelector(sel + ' .tan-detail');
      return d ? d.textContent : '';
    }, pageSel);
    chk('N6 点中心节点 → 详情显示「中心角色」与关系出处',
      centerDetail.indexOf('中心角色') >= 0 && centerDetail.indexOf('关系：') >= 0,
      centerDetail.slice(0, 120));

    await clickVB(page, ring.cx, ring.cy);              /* 环上一个节点 */
    const nodeDetail = await page.evaluate((sel) => {
      const d = document.querySelector(sel + ' .tan-detail');
      return d ? d.textContent : '';
    }, pageSel);
    chk('N6b 点环上节点 → 详情换成该节点（不再是中心）',
      nodeDetail.indexOf('中心角色') < 0 && nodeDetail.indexOf('关系：') >= 0 && nodeDetail.length > 10,
      nodeDetail.slice(0, 140));

    /* ---------------- N7 点边 → 关系原文 + 出处 + 时间口径 ----------------
       点**已画出来的那条线**的中点（取缩短后的线段坐标）——
       这样一定落在线上，且不会落进任何节点圆里。 */
    const eLine = await page.evaluate((sel) => {
      const l = document.querySelector(sel + ' .tan-edge');
      if (!l) return null;
      return {
        x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'),
        x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2')
      };
    }, pageSel);
    if (!eLine) throw new Error('图上一条边都没有 —— 夹具没造出关系依据');
    await clickVB(page, (eLine.x1 + eLine.x2) / 2, (eLine.y1 + eLine.y2) / 2);
    const edgeDetail = await page.evaluate((sel) => {
      const d = document.querySelector(sel + ' .tan-detail');
      return d ? d.textContent : '';
    }, pageSel);
    chk('N7 点连线 → 关系原文 / 数据出处 / 建立时间 + 修改时间不可知',
      edgeDetail.indexOf('↔') >= 0 &&
      edgeDetail.indexOf('数据出处：') >= 0 &&
      (edgeDetail.indexOf('修改时间不可知') >= 0 || edgeDetail.indexOf('没有时间戳') >= 0),
      edgeDetail.slice(0, 200));

    /* ---------------- N8 切列表：同一份结果 ---------------- */
    const lsBefore = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
    await page.evaluate((sel) => {
      document.querySelectorAll(sel + ' .iol-seg-btn')[1].click();
    }, pageSel);
    await sleep(300);
    await page.screenshot({ path: path.join(SHOT, 'tan-list.png') });
    const listTxt = await pageText(page);
    const listState = await page.evaluate((sel) => ({
      groups: document.querySelectorAll(sel + ' .tan-node-g').length,
      rows: document.querySelectorAll(sel + ' .tan-row').length,
      svg: !!document.querySelector(sel + ' .tan-svg')
    }), pageSel);
    const missing = expect.nodes.filter((n) => listTxt.indexOf(n.name) < 0).map((n) => n.name);
    const missEdge = expect.edges.filter((e) => listTxt.indexOf(e.label) < 0).map((e) => e.label);
    chk('N8 列表视图渲染全部 selector 节点与边（名字不截断）',
      missing.length === 0 && missEdge.length === 0 && !listState.svg && listState.rows > 0,
      '缺节点=' + JSON.stringify(missing) + ' 缺边=' + JSON.stringify(missEdge) + ' state=' + JSON.stringify(listState));
    chk('N8b 列表不泄露被 knownBy 挡掉的 NPC',
      listTxt.indexOf(W.hiddenNpc) < 0, '');
    chk('N8c 列表不泄露 privacy=self 的私密近况',
      listTxt.indexOf(W.secret) < 0, '');
    /* 可点行是 <button> —— UA 的边框/底色必须被抹掉（div 改 button 要补重置） */
    const rowReset = await page.evaluate((sel) => {
      const b = document.querySelector(sel + ' button.tan-row');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { border: cs.borderTopStyle, bg: cs.backgroundColor, w: Math.round(b.getBoundingClientRect().width) };
    }, pageSel);
    chk('N8e 可点行 button 已抹掉 UA 盒子（无边框 / 无底色 / 通栏）',
      !!rowReset && rowReset.border === 'none' &&
      (rowReset.bg === 'rgba(0, 0, 0, 0)' || rowReset.bg === 'transparent') && rowReset.w > 250,
      JSON.stringify(rowReset));

    /* ---------------- N9 切视图 / 打开 都 0 写入 ---------------- */
    const lsAfter = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
    chk('N9 打开关系网 + 切视图：localStorage 一字未动', lsBefore === lsAfter, '');

    /* 切回图视图 */
    await page.evaluate((sel) => {
      document.querySelectorAll(sel + ' .iol-seg-btn')[0].click();
    }, pageSel);
    await sleep(250);
    const backGroups = await page.evaluate((sel) => document.querySelectorAll(sel + ' .tan-node-g').length, pageSel);
    chk('N8d 切回图视图', backGroups === n1.groups, 'groups=' + backGroups);

    /* ---------------- N10 四主题可辨识 ---------------- */
    const themeReport = {};
    for (const th of ['grape', 'night', 'peach', 'sea']) {
      const r = await page.evaluate(([sel, id]) => {
        const phone = document.getElementById('phone');
        if (id === 'grape') phone.removeAttribute('data-theme');
        else phone.setAttribute('data-theme', id);
        const cs = (el) => el ? getComputedStyle(el) : null;
        const nameT = document.querySelector(sel + ' .tan-n-t');
        const nodeC = document.querySelector(sel + ' .tan-n-c');
        const ctrC = document.querySelector(sel + ' .tan-c-c');
        const edge = document.querySelector(sel + ' .tan-edge');
        const lb = document.querySelector(sel + ' .tan-n-lb');
        const meta = document.querySelector(sel + ' .tan-meta');
        const a = cs(nameT), b = cs(nodeC), c = cs(ctrC), d = cs(edge), e = cs(lb), f = cs(meta);
        return {
          nameFill: a && a.fill, nodeFill: b && b.fill, ctrFill: c && c.fill,
          edgeStroke: d && d.stroke, edgeOpacity: d && d.opacity,
          lbFill: e && e.fill, metaColor: f && f.color
        };
      }, [pageSel, th]);
      themeReport[th] = r;
      await page.screenshot({ path: path.join(SHOT, 'tan-theme-' + th + '.png') });
      await sleep(120);
    }
    await page.evaluate(() => document.getElementById('phone').removeAttribute('data-theme'));

    const themeBad = [];
    Object.keys(themeReport).forEach((th) => {
      const r = themeReport[th];
      if (!r.nameFill || r.nameFill === 'none') themeBad.push(th + ':节点文字无 fill');
      if (!r.nodeFill || r.nodeFill === 'none') themeBad.push(th + ':节点圆无 fill');
      if (r.nameFill === r.nodeFill) themeBad.push(th + ':文字与圆同色（读不清）');
      if (r.nameFill === r.ctrFill) themeBad.push(th + ':文字与中心圆同色');
      if (!r.edgeStroke || r.edgeStroke === 'none') themeBad.push(th + ':连线无 stroke');
      if (Number(r.edgeOpacity) < 0.25) themeBad.push(th + ':连线太淡 opacity=' + r.edgeOpacity);
      if (!r.lbFill || r.lbFill === r.nodeFill) themeBad.push(th + ':关系标签读不清');
    });
    chk('N10 四主题：节点 / 文字 / 连线 / 标签都可辨识（截图见 preview/phone-test/tan-theme-*.png）',
      themeBad.length === 0, themeBad.join(' / ') + ' ' + JSON.stringify(themeReport));

    /* ---------------- N11 未选身份不崩（selector 的空 user 分支） ---------------- */
    const before11 = sleepyErrs.length;
    await page.evaluate((w) => {
      const S = window.Sleepy;
      /* 指针指向一个不在本岛名册的身份 → activeUserOnIsland() 返回 null */
      S.core.switchTo(undefined, 'um_not_on_this_island');
      const t = S.nav.topCtx();
      if (t && t.refresh) t.refresh();
    }, W);
    await sleep(300);
    const noUserTxt = await pageText(page);
    chk('N11 未选身份（user=null）不崩、不报 [Sleepy] 错误',
      sleepyErrs.length === before11 && noUserTxt.length > 0,
      'errs=' + JSON.stringify(sleepyErrs.slice(before11)));
    await page.evaluate((w) => {
      const S = window.Sleepy;
      S.core.switchTo(w.m1, w.u);
      const t = S.nav.topCtx();
      if (t && t.refresh) t.refresh();
    }, W);
    await sleep(200);

    /* ---------------- N12 首页 04 与关系网同源 ---------------- */
    await page.evaluate(() => window.Sleepy.nav.closeAll());
    await page.evaluate(() => window.Sleepy.nav.open('ta', {}));
    await sleep(350);
    const taTxt = await page.evaluate(() => {
      const el = document.querySelector('.page[data-page="ta"]');
      return el ? el.textContent || '' : '';
    });
    const missTa = expect.nodes.filter((n) => taTxt.indexOf(n.name) < 0).map((n) => n.name);
    chk('N12 首页 04 节点与关系网 selector 同源（含人数与 knownBy 过滤）',
      missTa.length === 0 &&
      taTxt.indexOf(W.hiddenNpc) < 0 &&
      taTxt.indexOf(String(expect.nodes.length) + ' 人') >= 0 &&
      taTxt.indexOf('关系网') >= 0,
      '缺=' + JSON.stringify(missTa) + ' 人数=' + expect.nodes.length);
    await page.screenshot({ path: path.join(SHOT, 'tan-ta04.png') });

    /* ---------------- N13 331px 窄屏：溢出 + 触控 ---------------- */
    await page.evaluate(() => window.Sleepy.nav.closeAll());
    await page.setViewportSize({ width: 331, height: 700 });
    await page.evaluate(() => window.Sleepy.nav.open('ta-network', {}));
    await sleep(400);
    const ov2 = await overflow();
    const hit2 = await page.evaluate((sel) => {
      const out = [];
      document.querySelectorAll(sel + ' .tan-hit').forEach((h) => {
        const r = h.getBoundingClientRect();
        out.push({ w: Math.round(r.width), h: Math.round(r.height) });
      });
      return out;
    }, pageSel);
    const fit2 = await fitReport();
    chk('N13 331px 窄屏：无横向溢出、触控仍 ≥44、文字仍在圆内',
      ov2.doc <= 1 && ov2.graph <= 1 && hit2.every((b) => b.w >= 44 && b.h >= 44) && fit2.length === 0,
      JSON.stringify(ov2) + ' ' + JSON.stringify(hit2) + ' ' + fit2.join('/'));
    await page.screenshot({ path: path.join(SHOT, 'tan-narrow-331.png') });

    await page.evaluate(() => window.Sleepy.nav.closeAll());
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }

  const bad = results.filter((r) => !r.ok);
  console.log('\n' + (bad.length ? '✗ ' + bad.length + ' 项未过（共 ' + results.length + '）' : '✓ 全部 ' + results.length + ' 项通过'));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
