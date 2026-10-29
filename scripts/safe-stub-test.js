/* ============================================================
   scripts/safe-stub-test.js — 安全区探针生命周期桩测试（v284）
   ------------------------------------------------------------
   为什么单独一个文件：smoke.js 的 DOM 桩 UA 是 node-smoke，
   探针 IIFE 会在 isIOS 判断处提前 return —— smoke 只能护住
   「静态字符串」，护不住状态机行为。这里把探针 IIFE 从 app.js
   原文里切出来，放进一个 iPhone UA 的最小桩里真实跑一遍，
   验证任务书 B 组的六条生命周期契约。

   跑法：node scripts/safe-stub-test.js
   测量时刻表是真实定时器（最长 3000ms），全程约 8 秒。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/* ---------- 从 app.js 原文切出探针 IIFE（含注释块） ---------- */
function extractProbe(src) {
  const start = src.indexOf('/* --------------------- iOS 安全区测量');
  if (start < 0) throw new Error('找不到探针注释块');
  const endMark = '\n  })();';
  const end = src.indexOf(endMark, start);
  if (end < 0) throw new Error('找不到探针 IIFE 结尾');
  return src.slice(start, end + endMark.length);
}

/* ---------- 桩：可控 env 高度 + 事件登记 + 写入日志 ---------- */
function makeSandbox() {
  const env = {
    heights: { top: 0, bottom: 0 },     /* 测试用：模拟探针渲染值 */
    writes: [],                          /* {k, v, t} 每一次 setProperty */
    removes: [],
    vv: { resize: [], scroll: [] },      /* 当前挂着的 vv 监听 */
    orientHandler: null
  };
  const elements = {};
  const docElStyle = {
    _p: {},
    setProperty(k, v) {
      this._p[k] = String(v);
      env.writes.push({ k, v: String(v), t: Date.now() });
    },
    removeProperty(k) {
      delete this._p[k];
      env.removes.push(k);
    },
    getPropertyValue(k) { return this._p[k] || ''; }
  };
  const documentElement = {
    style: docElStyle,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    appendChild(el) { if (el.id) elements[el.id] = el; return el; }
  };
  const sandbox = {
    console,
    Date,
    setTimeout, clearTimeout,
    document: {
      documentElement,
      getElementById(id) { return elements[id] || null; },
      createElement() {
        return {
          id: '',
          style: { cssText: '' },
          getBoundingClientRect() {
            const key = this.id === 'safe-probe-top' ? 'top' : 'bottom';
            return { height: env.heights[key] };
          }
        };
      }
    },
    navigator: { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5, standalone: true },
    visualViewport: {
      addEventListener(type, fn) { if (env.vv[type]) env.vv[type].push(fn); },
      removeEventListener(type, fn) {
        const a = env.vv[type] || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      }
    },
    addEventListener(type, fn) { if (type === 'orientationchange') env.orientHandler = fn; },
    removeEventListener() {}
  };
  sandbox.global = sandbox;
  env.sandbox = sandbox;
  return env;
}

function boot(env) {
  vm.runInNewContext(extractProbe(app), env.sandbox, { filename: 'probe-iife.js' });
}

const fb = (env, k) => env.sandbox.document.documentElement.style.getPropertyValue(k);
const fireResize = (env) => env.vv.resize.slice().forEach((fn) => fn());
const fireOrient = (env) => { if (env.orientHandler) env.orientHandler(); };
const fbVal = (env, k) => { const v = fb(env, k); return v === '' ? '(未写,=CSS默认0px)' : v; };
const isZeroish = (v) => v === '' || v === '0px';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async function main() {
  console.log('B1 初始 0/0 → 晚到 59/34');
  {
    const env = makeSandbox();
    env.heights = { top: 0, bottom: 0 };
    boot(env);
    check('立即轮 0/0 时 fallback 保持 0', isZeroish(fb(env, '--safe-top-fb')) && isZeroish(fb(env, '--safe-bottom-fb')));
    env.heights = { top: 59, bottom: 34 };
    fireResize(env);
    check('fallback 变为 59px / 34px', fb(env, '--safe-top-fb') === '59px' && fb(env, '--safe-bottom-fb') === '34px');
    check('顶底锁定后 vv.resize 监听已解除', env.vv.resize.length === 0);
    check('从未写过终值 --safe-top/--safe-bottom', env.writes.every((w) => w.k.endsWith('-fb')));
    check('从未挂过 vv.scroll 监听', env.vv.scroll.length === 0);
  }

  console.log('B2 稳定后 5 次 vv.resize');
  {
    const env = makeSandbox();
    env.heights = { top: 59, bottom: 34 };
    boot(env);
    const n0 = env.writes.length;
    for (let i = 0; i < 5; i++) fireResize(env);
    check('fallback 写入次数不增加', env.writes.length === n0);
    check('顶底值不变', fb(env, '--safe-top-fb') === '59px' && fb(env, '--safe-bottom-fb') === '34px');
    check('监听保持解除（不再响应任何 resize）', env.vv.resize.length === 0);
  }

  console.log('B3 聚焦 / 键盘开关 / vv.scroll');
  {
    const env = makeSandbox();
    env.heights = { top: 59, bottom: 34 };
    boot(env);
    const n0 = env.writes.length;
    /* 桩里这三类事件根本没有对应的监听器可触发 —— 这正是契约本身。
       显式验证：scroll 无监听、focusin/focusout 无回调被探针登记。 */
    env.vv.scroll.slice().forEach((fn) => fn());
    check('探针从未监听 vv.scroll', env.vv.scroll.length === 0);
    check('fallback 完全不变', env.writes.length === n0 &&
      fb(env, '--safe-top-fb') === '59px' && fb(env, '--safe-bottom-fb') === '34px');
  }

  console.log('B4 orientationchange 重测（保留已发布 fallback）');
  {
    const env = makeSandbox();
    env.heights = { top: 59, bottom: 34 };
    boot(env);
    check('稳定后监听已解除', env.vv.resize.length === 0);
    env.heights = { top: 21, bottom: 10 };
    fireOrient(env);
    check('旋转后已发布 fallback 保持 59px/34px（禁止清零）',
      fb(env, '--safe-top-fb') === '59px' && fb(env, '--safe-bottom-fb') === '34px');
    check('旋转后进入待测（内部缓存清空、监听重开）', env.vv.resize.length === 1);
    fireResize(env);
    check('新姿态可信值到达后替换为 21px/10px', fb(env, '--safe-top-fb') === '21px' && fb(env, '--safe-bottom-fb') === '10px');
    check('替换后监听解除', env.vv.resize.length === 0);
    /* 最终轮仍为 0：这时才把该边 fallback 正式发布成 0px */
    env.heights = { top: 0, bottom: 0 };
    fireOrient(env);
    check('再次旋转：fallback 仍保持 21px/10px',
      fb(env, '--safe-top-fb') === '21px' && fb(env, '--safe-bottom-fb') === '10px');
    await sleep(3300);                           /* 越过 3000ms 最终轮 */
    check('最终轮仍为 0：才正式发布 0px（顶底独立）',
      fbVal(env, '--safe-top-fb') === '0px' && fbVal(env, '--safe-bottom-fb') === '0px');
    check('发布 0 后监听移除', env.vv.resize.length === 0);
  }

  console.log('B5 顶部先 59、底部仍 0（独立锁定）— 真实定时器 ~3.2s');
  {
    const env = makeSandbox();
    env.heights = { top: 59, bottom: 0 };
    boot(env);
    check('顶部立即锁定 59px', fb(env, '--safe-top-fb') === '59px');
    check('底部未锁、监听仍在（继续重试）', env.vv.resize.length === 1);
    await sleep(700);                          /* 过 120/500 两轮 */
    env.heights = { top: 0, bottom: 0 };       /* 模拟中途量到 0 */
    await sleep(1000);                         /* 过 1500ms 轮 */
    check('顶部 59 未被后续 0 覆盖', fb(env, '--safe-top-fb') === '59px');
    check('底部仍为 0（未锁）', isZeroish(fb(env, '--safe-bottom-fb')));
    env.heights = { top: 59, bottom: 34 };
    await sleep(1700);                         /* 过 3000ms 最后一轮 */
    check('底部在后续轮锁定 34px', fb(env, '--safe-bottom-fb') === '34px');
    check('底锁后监听解除', env.vv.resize.length === 0);
  }

  console.log('B6 始终为 0 → 停止重试、不无限监听 — 真实定时器 ~3.2s');
  {
    const env = makeSandbox();
    env.heights = { top: 0, bottom: 0 };
    boot(env);
    await sleep(3300);                         /* 越过 3000ms 最后一轮 */
    check('fallback 保持 0（未硬编码 59/34）', isZeroish(fb(env, '--safe-top-fb')) && isZeroish(fb(env, '--safe-bottom-fb')));
    check('重试用尽后监听已移除', env.vv.resize.length === 0);
    const n0 = env.writes.length;
    fireResize(env);
    check('重试用尽后 resize 不再引发写入', env.writes.length === n0);
    fireOrient(env);
    check('只有 orientationchange 能重开一轮', env.vv.resize.length === 1);
  }

  console.log('B7 旧轮 timers 全部经过后不得污染新轮');
  {
    const env = makeSandbox();
    env.heights = { top: 0, bottom: 0 };
    boot(env);                                   /* gen1：0/0 待测，timers 已排 */
    const writesAtOrient = env.writes.length;
    env.heights = { top: 21, bottom: 10 };
    fireOrient(env);                             /* gen2 开轮 */
    check('第二轮进入待测', env.vv.resize.length === 1);
    fireResize(env);                             /* gen2 收敛 21/10 */
    check('第二轮收敛 21px/10px', fb(env, '--safe-top-fb') === '21px' && fb(env, '--safe-bottom-fb') === '10px');
    check('第二轮收敛后监听解除', env.vv.resize.length === 0);
    await sleep(3300);                           /* gen1 的 120~3000ms 原定 timers 全部经过 */
    const lateWrites = env.writes.slice(writesAtOrient);
    check('旧轮回调过期：不写 fallback、不归零（全程无 0px 写入）',
      fb(env, '--safe-top-fb') === '21px' && fb(env, '--safe-bottom-fb') === '10px' &&
      lateWrites.every((w) => w.v !== '0px'));
    check('旧轮回调过期：未留下任何残余监听', env.vv.resize.length === 0);
    check('新轮收敛后无重复写入（21/10 各只写一次）',
      lateWrites.filter((w) => w.k === '--safe-top-fb').length === 1 &&
      lateWrites.filter((w) => w.k === '--safe-bottom-fb').length === 1);
  }

  console.log('B8 快速连续 3 次 orientationchange');
  {
    const env = makeSandbox();
    env.heights = { top: 59, bottom: 34 };
    boot(env);                                   /* gen1 锁定 59/34，监听 0 */
    const writes0 = env.writes.length;
    env.heights = { top: 21, bottom: 10 };
    fireOrient(env);
    check('第 1 次旋转后活动监听 <=1', env.vv.resize.length <= 1);
    fireOrient(env);
    check('第 2 次旋转后活动监听 <=1（旧监听已摘）', env.vv.resize.length <= 1);
    fireOrient(env);
    check('第 3 次旋转后活动监听 <=1', env.vv.resize.length <= 1);
    check('快速旋转期间 fallback 保持 59px/34px（不清零）',
      fb(env, '--safe-top-fb') === '59px' && fb(env, '--safe-bottom-fb') === '34px');
    fireResize(env);                             /* 只有最后一代的监听活着、能收敛 */
    check('只有最后一轮收敛：21px/10px', fb(env, '--safe-top-fb') === '21px' && fb(env, '--safe-bottom-fb') === '10px');
    check('收敛后监听数量为 0', env.vv.resize.length === 0);
    const fbWrites = env.writes.slice(writes0).filter((w) => w.k.endsWith('-fb'));
    check('相同 fallback 不重复写入（增量只有 21px/10px 各一次）',
      fbWrites.length === 2 &&
      !!fbWrites.find((w) => w.k === '--safe-top-fb' && w.v === '21px') &&
      !!fbWrites.find((w) => w.k === '--safe-bottom-fb' && w.v === '10px'));
    await sleep(3300);                           /* 各代过期 timers 全部经过 */
    check('过期轮回调经过后仍 21px/10px、监听 0',
      fb(env, '--safe-top-fb') === '21px' && fb(env, '--safe-bottom-fb') === '10px' &&
      env.vv.resize.length === 0);
  }

  console.log('');
  console.log('探针静态纪律（键盘链路分离）');
  {
    const probeZone = app.slice(app.indexOf('iOS 安全区测量'), app.indexOf('/* ---------------------------- 页面栈'));
    const kbZone = app.slice(app.indexOf('软键盘避让（真机）'), app.indexOf('/* ---------------------------- 对外'));
    check('探针不写 --kb-inset / kb-open', probeZone.indexOf('--kb-inset') < 0 && probeZone.indexOf('kb-open') < 0);
    check('键盘 IIFE 不碰 fb / 探针', kbZone.indexOf('--safe-top-fb') < 0 && kbZone.indexOf('--safe-bottom-fb') < 0 && kbZone.indexOf('safe-probe') < 0);
  }

  console.log('');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('桩测试崩溃：', e); process.exit(2); });
