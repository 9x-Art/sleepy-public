/*!
 * 亚克力挂件灯 · 可复用核心
 * ---------------------------------------------------------------------------
 * 纯代码生成，零素材：骨架、卡片贴图、珠子、光晕、环境反射全部现场画出来，
 * 不含任何图片 / 模型文件。three.js 之外没有第二个依赖。
 *
 * 依赖：three.js（r169 验证通过）
 *   · 用打包器：npm i three
 *   · 不用打包器：在页面里加一条 importmap
 *       <script type="importmap">
 *       { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js" } }
 *       </script>
 *
 * 用法：
 *   import createAcrylicLamp from './acrylic-lamp-core.js';
 *
 *   const lamp = createAcrylicLamp(document.getElementById('stage'), {
 *     cards: [{ text: '好事\n会发生', art: 'cat', tone: 'pink' }],
 *   });
 *   lamp.setLight('moon');     // 换灯
 *   lamp.dispose();            // 组件卸载时收干净
 *
 * 本文件是从 acrylic-lamp.html 的「可复用核心」段自动抽出的。
 * 请改源文件再重新导出（node tools/build-core.cjs），不要在这里直接改 —— 下次导出会被覆盖。
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- 确定性随机：同一个 seed 永远画出同一张卡 ---------- */
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 结构参数：想调比例改这里就够了 ---------- */
const CFG = {
  pole:     { r: 1.3, from: 0, to: 88 },
  base:     { r: 13.0, h: 2.4 },

  /* 四层环，从内到外：半径递增、高度递减，像一把撑开的伞。
     三条硬约束都按最坏情况验算过（抖动取满、尺寸取上限）：
       · 层间半径区间互不相交 → 层与层不会插在一起；
       · 每层张数满足「弦长 2r·sin(π/n) ≥ 卡片宽度」→ 同层相邻不重叠；
       · 垂直步距要够大，每层各占一条横带 → 侧看每层才分得清。
     第三条最容易被忽略：吊绳只要放长一点（比如 3~8.5），外面那层的卡片就会荡进
     下一层的位置，四层立刻糊成一片。所以这里 chainMax-chainMin 只留 1.0，步距给到 15~16。 */
  rings: [
    { r: 13.5, y: 87.0, tube: 0.42, count:  6, chainMin: 2.4, chainMax: 3.4, jitter: 1.2, scale: 0.62 },
    { r: 22.0, y: 72.0, tube: 0.48, count:  8, chainMin: 2.4, chainMax: 3.4, jitter: 1.6, scale: 0.74 },
    { r: 30.5, y: 57.0, tube: 0.56, count: 10, chainMin: 2.4, chainMax: 3.4, jitter: 2.0, scale: 0.87 },
    { r: 38.5, y: 41.0, tube: 0.64, count: 12, chainMin: 2.4, chainMax: 3.4, jitter: 2.4, scale: 1.00 },
  ],

  /* 比例 3:4 → 2:3。注意这里是"把宽度收窄"，不是"把高度加高"：
     卡片是从环上垂下来的，加高就会顶到下一层的卡片，四层立刻挤在一起；
     收窄则垂坠高度分毫不动，环间距、构图、相机全都不用重新调。
     顺带得到一个好处 —— 同层相邻卡片之间空出来了，整盏灯会显修长。 */
  card:     { w: 14.6, h: 21.9 },    // 宽高比必须和 CARD_TEX / CARD_UNIT 保持一致
  /* phi 越接近 π/2 视线越平：四层在屏幕上才拉得开（俯视会把层间距压扁），
     同时环本身也接近侧视，不会糊成一块厚板 */
  cam:      { dist: 176, min: 100, max: 360, phi: 1.535, theta: 0.5, targetY: 50 },
};
/* 卡片贴图分辨率。绘图坐标系永远固定在 CARD_UNIT（下面所有绘图常量都按它写），
   真实画布由 paintCard 一次性放大 —— 想要更清晰，只改 CARD_TEX 这两个数，
   不必动任何绘图代码。CARD_TEX_HI 是"点击放大"时额外再乘的倍数。 */
const CARD_TEX = { w: 384, h: 576 };
const CARD_UNIT = { w: 256, h: 384 };
const CARD_TEX_HI = 2;

/* ---------- 配色：卡片贴纸的色板。饱和一点，不然会被灯光冲成一片白 ---------- */
/* ★ 2026-10-06 用户定稿的 5 色柔和浅色板（透亮方向）：
     薄荷汽水 #DCF5E8 / 晨雾蓝 #DEECFC / 西柚苏打 #FFE3DE /
     燕麦暖白 #FFF6E6 / 雾灰香芋 #E8E6F1
   这批 fill 本身就是高明度低饱和（L≈94%），不再是旧的高饱和粉彩
   （#FF9EC2 那批会读成实心塑料板）。ink/accent 按各底色配好保证可读。 */
const TONE_MINT    = { fill: '#DCF5E8', ink: '#33785B', accent: '#A3E6C6' }; // 薄荷汽水
const TONE_SKY     = { fill: '#DEECFC', ink: '#3F6BA5', accent: '#AFCDF6' }; // 晨雾蓝
const TONE_CORAL   = { fill: '#FFE3DE', ink: '#A55A50', accent: '#FFBBB1' }; // 西柚苏打
const TONE_CREAM   = { fill: '#FFF6E6', ink: '#8A744A', accent: '#F2E1BC' }; // 燕麦暖白
const TONE_LILAC   = { fill: '#E8E6F1', ink: '#4C4763', accent: '#BCB6D2' }; // 雾灰香芋

const PALETTE = {
  /* 为了兼容既有调用面（tone 名是对外 API），11 个键全部保留、各自映射到
     上面 5 个色调对象 —— 想加新颜色就补一个 TONE_xxx + 把键改指过去，
     别在调用方绕。 */
  pink:   TONE_CORAL,
  butter: TONE_CREAM,
  mint:   TONE_MINT,
  sky:    TONE_SKY,
  lilac:  TONE_LILAC,
  peach:  TONE_CORAL,
  aqua:   TONE_SKY,
  cream:  TONE_CREAM,
  coral:  TONE_CORAL,
  lime:   TONE_MINT,
  ink:    TONE_LILAC,
};

/* ---------- 手写体字体栈：全部走系统字体，不下载任何字体文件 ---------- */
const HAND_FONT = '"Kaiti SC","STKaiti","KaiTi","楷体","AR PL UKai CN","Segoe Script","Comic Sans MS",cursive';

/* ★ 2026-10-06 灯牌自定义字体：宿主页面可能已经用 FontFace 加载了
   webfont（本项目走外观设置的 fontUrl → 'SleepyCustomFont'）。
   create 选项传 font: 'SleepyCustomFont'（或 api.setFont(名字)）就会把它
   插到字体栈最前面 —— 名字里的引号会被剥掉防注入；不传就是原楷体栈。
   ⚠️ 换字体只影响**之后画的**卡片：字体晚于创建就绪的话，宿主要再调一次
   setCards(当前卡片) 触发重画。 */
let CARD_FONT_USER = '';
function cardFontStack() {
  const safe = CARD_FONT_USER.replace(/["']/g, '').trim();
  return (safe ? '"' + safe + '",' : '') + HAND_FONT;
}

/* ---------- Canvas 小工具 ---------- */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* 先量再画，才能把一行字精确居中 */
function measureLine(ctx, line, size) {
  ctx.font = size + 'px ' + cardFontStack();
  let w = 0;
  for (const ch of line) w += ctx.measureText(ch).width * 0.99;
  return w;
}

/* 一个字一个字地落笔，每个字带一点点随机歪斜 —— 手写的味道全在这 */
function drawHandLine(ctx, line, cx, cy, size, color, rnd, tilt) {
  ctx.font = size + 'px ' + cardFontStack();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  /* 描一圈极细的同色边 = 把手写体悄悄加粗约 4%。
     小字号下这一个动作对可读性的帮助，比把贴图分辨率翻一倍还明显。 */
  ctx.lineWidth = Math.max(0.6, size * 0.075);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let x = cx - measureLine(ctx, line, size) / 2;
  for (const ch of line) {
    const w = ctx.measureText(ch).width * 0.99;
    ctx.save();
    /* 歪斜幅度收了一点：太小没有手写味，太大会把字糊成一团 */
    ctx.translate(x + w / 2, cy + (rnd() - 0.5) * size * 0.09);
    ctx.rotate((rnd() - 0.5) * 0.085 + (tilt || 0));
    ctx.strokeText(ch, 0, 0);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    x += w;
  }
}

/* 多行文字块：自动缩到框内 */
function drawHandBlock(ctx, lines, cx, cy, maxW, size, color, rnd, gap) {
  let s = size;
  for (let i = 0; i < 8; i++) {
    const widest = Math.max(...lines.map((l) => measureLine(ctx, l, s)));
    if (widest <= maxW) break;
    s *= maxW / widest;
  }
  const step = s * (gap || 1.42);
  const y0 = cy - ((lines.length - 1) * step) / 2;
  lines.forEach((l, i) => drawHandLine(ctx, l, cx, y0 + i * step, s, color, rnd, 0));
  return s;
}

/* ★ 2026-10-10 留言字太小（反馈）：原来 paintCard 只按 \n 分行，
   40 字留言被压成一整行再硬缩到卡宽 —— 字缩到几像素根本看不清。
   这里按 maxW 把长行逐字折行（卡面全是中文短句，逐字折就够），
   调用方折完若行数太多，再按可用高度回推字号 —— 宁可字略小也要整段
   放下，但不会再出现 5px 的蚂蚁字。 */
function wrapLines(ctx, lines, maxW, size) {
  const out = [];
  lines.forEach((raw) => {
    let cur = '';
    for (const ch of raw) {
      const test = cur + ch;
      if (cur && measureLine(ctx, test, size) > maxW) { out.push(cur); cur = ch; }
      else cur = test;
    }
    if (cur) out.push(cur);
  });
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   手绘涂鸦图案库
   每个函数签名统一：(ctx, cx, cy, s, tone)
   cx/cy 是图案中心，s 是可用尺寸（约等于图案的外接方框边长）
   想加自己的图案，往这里塞一个同名函数即可，然后在 cards 里用 art:'你的名字'
   ═══════════════════════════════════════════════════════════════════════ */
const ART = {
  /* 小猫 */
  cat(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.055;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#fff';
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + d * r * 0.62, cy - r * 0.40);
      ctx.lineTo(cx + d * r * 0.84, cy - r * 0.98);
      ctx.lineTo(cx + d * r * 0.20, cy - r * 0.72);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.88, r * 0.78, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = t.accent;
    ctx.beginPath(); ctx.arc(cx - r * 0.52, cy + r * 0.24, s * 0.075, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.52, cy + r * 0.24, s * 0.075, 0, TAU); ctx.fill();
    ctx.fillStyle = t.ink;
    ctx.beginPath(); ctx.arc(cx - r * 0.32, cy - r * 0.06, s * 0.055, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.32, cy - r * 0.06, s * 0.055, 0, TAU); ctx.fill();
    ctx.strokeStyle = t.ink;
    ctx.lineWidth = s * 0.045;
    ctx.beginPath(); ctx.arc(cx - r * 0.11, cy + r * 0.20, s * 0.10, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + r * 0.11, cy + r * 0.20, s * 0.10, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.lineWidth = s * 0.03;
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + d * r * 0.55, cy + r * 0.30);
      ctx.lineTo(cx + d * r * 1.05, cy + r * 0.18);
      ctx.moveTo(cx + d * r * 0.55, cy + r * 0.42);
      ctx.lineTo(cx + d * r * 1.05, cy + r * 0.50);
      ctx.stroke();
    }
  },

  /* 小熊 */
  bear(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.055;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#fff';
    for (const d of [-1, 1]) {
      ctx.beginPath(); ctx.arc(cx + d * r * 0.70, cy - r * 0.62, r * 0.32, 0, TAU); ctx.fill(); ctx.stroke();
    }
    ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.04, r * 0.80, r * 0.74, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = t.accent;
    ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.34, r * 0.40, r * 0.30, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = t.ink;
    ctx.beginPath(); ctx.arc(cx - r * 0.30, cy - r * 0.14, s * 0.055, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.30, cy - r * 0.14, s * 0.055, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.24, s * 0.085, s * 0.062, 0, 0, TAU); ctx.fill();
  },

  /* 皇冠 */
  crown(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.06;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#FFE07A';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.92, cy + r * 0.48);
    ctx.lineTo(cx - r * 0.78, cy - r * 0.56);
    ctx.lineTo(cx - r * 0.34, cy + r * 0.02);
    ctx.lineTo(cx, cy - r * 0.82);
    ctx.lineTo(cx + r * 0.34, cy + r * 0.02);
    ctx.lineTo(cx + r * 0.78, cy - r * 0.56);
    ctx.lineTo(cx + r * 0.92, cy + r * 0.48);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = t.accent;
    for (const x of [-0.5, 0, 0.5]) {
      ctx.beginPath(); ctx.arc(cx + r * x, cy + r * 0.16, s * 0.072, 0, TAU); ctx.fill();
    }
  },

  /* 星星 */
  star(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.06;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#FFE382';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.46 : r * 0.94;
      const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = t.ink;
    ctx.beginPath(); ctx.arc(cx - r * 0.22, cy - r * 0.06, s * 0.035, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.22, cy - r * 0.06, s * 0.035, 0, TAU); ctx.fill();
  },

  /* 小花 */
  flower(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.055;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * r * 0.48, cy + Math.sin(a) * r * 0.48, r * 0.34, r * 0.26, a, 0, TAU);
      ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = t.accent;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.30, 0, TAU); ctx.fill(); ctx.stroke();
  },

  /* 太阳 */
  sun(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.06;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#FFD97A';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.52, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.lineWidth = s * 0.055;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.70, cy + Math.sin(a) * r * 0.70);
      ctx.lineTo(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94);
      ctx.stroke();
    }
  },

  /* 爱心 */
  heart(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.06;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#FF8FA8';
    ctx.beginPath();
    ctx.moveTo(cx, cy + r * 0.72);
    ctx.bezierCurveTo(cx - r * 1.30, cy - r * 0.18, cx - r * 0.52, cy - r * 0.98, cx, cy - r * 0.32);
    ctx.bezierCurveTo(cx + r * 0.52, cy - r * 0.98, cx + r * 1.30, cy - r * 0.18, cx, cy + r * 0.72);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.72)';
    ctx.beginPath(); ctx.ellipse(cx - r * 0.36, cy - r * 0.22, r * 0.20, r * 0.13, -0.6, 0, TAU); ctx.fill();
  },

  /* 月亮 */
  /* 月牙**不能**在目标画布上"擦"出来。
     上一版是「画一个圆 → destination-out 再擦一个圆」—— destination-out 是
     把目标像素的 alpha 真的减掉，擦穿的不只是刚画的那个圆，还有它**下面**的
     底板和整张卡片。结果这张卡的贴图上就留了一个真的洞：
     放大之后从月亮里能看见背后的灯（底色是什么样就是什么样）。
     现在月牙先在一张离屏画布上抠好，再整张带 alpha 贴回来 —— 视觉一模一样，
     但擦的只是那张离屏画布，碰不到底板。 */
  moon(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    /* 离屏画布按当前绘图缩放建，清晰度和直接画在卡片上完全一致 */
    const k = (ctx.getTransform && ctx.getTransform().a) || 1;
    const box = s * 1.75;
    const off = document.createElement('canvas');
    off.width = off.height = Math.max(64, Math.ceil(box * k));
    const oc = off.getContext('2d');
    oc.scale(off.width / box, off.height / box);
    oc.translate(box / 2, box / 2);

    oc.lineJoin = 'round';
    oc.lineWidth = s * 0.06;
    oc.strokeStyle = t.ink;
    oc.fillStyle = '#FFE7A8';
    oc.beginPath();
    oc.arc(0, 0, r * 0.82, 0, TAU);
    oc.fill(); oc.stroke();
    oc.globalCompositeOperation = 'destination-out';
    oc.beginPath(); oc.arc(r * 0.44, -r * 0.20, r * 0.74, 0, TAU); oc.fill();
    oc.globalCompositeOperation = 'source-over';
    oc.fillStyle = t.ink;
    oc.beginPath(); oc.arc(-r * 0.28, r * 0.10, s * 0.032, 0, TAU); oc.fill();
    oc.beginPath(); oc.arc(-r * 0.10, r * 0.44, s * 0.030, 0, TAU); oc.fill();

    ctx.drawImage(off, cx - box / 2, cy - box / 2, box, box);
  },

  /* 云朵 */
  /* 云朵：三个圆拼出来的一朵云。
     要点是「先填、后描」—— 填充直接把三个圆叠起来（形状自然），
     描边时把每个圆裁掉落在另外两个圆里面的部分，于是只剩最外圈那几段弧。
     这样既不会留下圆与圆之间的内部线条，也不会出现路径收口收出来的直边。 */
  cloud(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    const circles = [
      { x: cx - r * 0.56, y: cy + r * 0.16, r: r * 0.38 },
      { x: cx - r * 0.02, y: cy, r: r * 0.54 },
      { x: cx + r * 0.60, y: cy + r * 0.20, r: r * 0.34 },
    ];
    const BASE = cy + r * 0.54;        // 云底：三个圆都正好跟这条线相切

    /* 1) 填出剪影（三个圆 + 一块补在底边缺口上的矩形，矩形完全藏在圆里） */
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (const c of circles) { ctx.moveTo(c.x + c.r, c.y); ctx.arc(c.x, c.y, c.r, 0, TAU); }
    ctx.fill();
    ctx.fillRect(circles[0].x, BASE - r * 0.22, circles[2].x - circles[0].x, r * 0.22);

    /* 2) 只描最外圈那几段弧 */
    ctx.strokeStyle = t.ink;
    ctx.lineWidth = s * 0.055;
    for (let k = 0; k < 3; k++) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - s, cy - s, s * 2, s * 2);
      for (let j = 0; j < 3; j++) {
        if (j === k) continue;
        const o = circles[j];
        ctx.moveTo(o.x + o.r, o.y);
        ctx.arc(o.x, o.y, o.r, 0, TAU);
      }
      ctx.clip('evenodd');
      const c = circles[k];
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    /* 3) 云底那一条 */
    ctx.beginPath();
    ctx.moveTo(circles[0].x, BASE);
    ctx.lineTo(circles[2].x, BASE);
    ctx.stroke();

    /* 4) 睡着的小脸 */
    ctx.fillStyle = t.soft;
    ctx.beginPath(); ctx.arc(cx - r * 0.22, cy + r * 0.04, s * 0.034, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.26, cy + r * 0.14, s * 0.034, 0, TAU); ctx.fill();
  },

  /* 笑脸 */
  smile(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.06;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = '#FFE07A';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = t.ink;
    ctx.beginPath(); ctx.arc(cx - r * 0.30, cy - r * 0.18, s * 0.052, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.30, cy - r * 0.18, s * 0.052, 0, TAU); ctx.fill();
    ctx.strokeStyle = t.ink;
    ctx.lineWidth = s * 0.05;
    ctx.beginPath(); ctx.arc(cx, cy + r * 0.06, r * 0.46, 0.28, Math.PI - 0.28); ctx.stroke();
  },

  /* 小鱼 */
  fish(ctx, cx, cy, s, t) {
    const r = s * 0.5;
    ctx.lineWidth = s * 0.055;
    ctx.strokeStyle = t.ink;
    ctx.fillStyle = t.accent;
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.12, cy, r * 0.74, r * 0.46, 0, 0, TAU);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.58, cy);
    ctx.lineTo(cx + r * 1.02, cy - r * 0.42);
    ctx.lineTo(cx + r * 1.02, cy + r * 0.42);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = t.ink;
    ctx.beginPath(); ctx.arc(cx - r * 0.52, cy - r * 0.10, s * 0.042, 0, TAU); ctx.fill();
  },

  /* text = 不画图案，整张卡留给手写字 */
  text() {},
};

/* ---------- 画卡片要用的三个小工具 ---------- */

/* 把十六进制颜色调亮 / 调暗一点点；k 为负是变暗 */
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return 'rgb(' + f((n >> 16) & 255) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
}

/* shade 的带透明度版本：把色板颜色往白里冲 k（0~1），再给它一个 alpha。
   用来给板面掺"一丁点本张卡的色相" —— 直接复用 shade 的白点插值，不另算一套。 */
function tint(hex, k, a) {
  return shade(hex, k).replace('rgb(', 'rgba(').replace(')', ',' + a + ')');
}

/* ── 磨砂玻璃的三张底图 ──────────────────────────────────────────────
   磨砂玻璃和抛光亚克力的区别，说到底是三件事，缺一件就会退回"塑料片"：
     ① 面是漫射的 —— 高光被打散成一片柔光，而不是一条硬亮线；
     ② 面是不匀的 —— 一块雾得重、一块雾得轻，均匀的磨砂看着像贴了层薄膜；
     ③ 边缘是亮的 —— 光从断面透进去、在板子里乱窜，最后从边上溢出来。
   ①②③ 分别对应下面三张图和后面板面里的那段"边缘聚光"。

   （原先这里是一套 paperNoise 纸纹。磨砂的方向定下来之后它就没有用武之地了：
     纸纹会把材质一把拉回"纸张"，而磨砂要的是"玻璃"——所以整套换掉，没有留。 ） */

/* ① 喷砂颗粒。纸纹用的是"暗点"（压出凹陷），
   磨砂要的是"亮点"—— 无数个微小的散射中心在提亮，所以用白色 + 更低的 alpha。
   颗粒尺寸必须跟着画布分辨率反向缩回去，
   否则放大态（分辨率 ×CARD_TEX_HI）会把砂粒放大成一颗颗麻点。 */
let FROST_GRAIN = null;
function frostPattern(ctx, k) {
  if (!FROST_GRAIN) {
    const n = 128, c = document.createElement('canvas');
    c.width = c.height = n;
    const nc = c.getContext('2d');
    const d = nc.createImageData(n, n);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
      d.data[i + 3] = 14 + Math.random() * 44;
    }
    nc.putImageData(d, 0, 0);
    FROST_GRAIN = c;
  }
  const p = ctx.createPattern(FROST_GRAIN, 'repeat');
  if (k && k !== 1 && p && p.setTransform && typeof DOMMatrix !== 'undefined') {
    p.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0]));
  }
  return p;
}

/* ② 云絮。几团半径很大的柔光斑铺在 50% 灰上，配 overlay 混合使用 ——
   灰不动、亮处提亮、暗处压暗。预烘四张，按 seed 挑一张：
   每一张卡因此是"另一块玻璃"，而不是同一块玻璃复印出来的。 */
const MOTTLE = [];
function mottlePattern(ctx, k, variant) {
  const idx = (variant | 0) & 3;
  if (!MOTTLE[idx]) {
    const n = 128, c = document.createElement('canvas');
    c.width = c.height = n;
    const nc = c.getContext('2d');
    nc.fillStyle = 'rgb(128,128,128)';
    nc.fillRect(0, 0, n, n);
    const r = rngFrom(4483 + idx * 7717);
    for (let i = 0; i < 20; i++) {
      const x = r() * n, y = r() * n, rad = n * (0.16 + r() * 0.30);
      const up = r() > 0.46;
      const g = nc.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, up ? 'rgba(198,198,198,0.42)' : 'rgba(104,104,104,0.30)');
      g.addColorStop(1, up ? 'rgba(198,198,198,0)' : 'rgba(104,104,104,0)');
      nc.fillStyle = g;
      nc.beginPath();
      nc.arc(x, y, rad, 0, TAU);
      nc.fill();
    }
    MOTTLE[idx] = c;
  }
  const p = ctx.createPattern(MOTTLE[idx], 'repeat');
  if (k && k !== 1 && p && p.setTransform && typeof DOMMatrix !== 'undefined') {
    p.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0]));
  }
  return p;
}

/* ③ 粗糙度贴图，交给材质的 roughnessMap。three.js 只读这张图的 G 通道，
   所以画成灰阶即可。UV 直接复用卡片贴图的 UV，平铺 2.5×3.4 让颗粒更细。

   取值区间必须**卡在中间偏亮的一小段**（175~236 → 乘上 roughness 0.46 得
   0.32~0.43）。这里有一个很容易踩的坑：粗糙度贴图一旦出现暗斑，
   那几块地方就变成镜面 —— 在一片磨砂上凭空多出几个贼亮的高光点，
   比不做还糟。所以下面叠的云絮也只用「亮/略暗」，绝不下探到 0。 */
function makeFrostRoughTexture() {
  const n = 256, c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d');
  const d = ctx.createImageData(n, n);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = 182 + Math.random() * 54;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  /* 再压几团大颗粒：纯随机会细得像砂纸，"一块雾重一块雾轻"才是磨砂玻璃。
     注意两个色标都在中灰以上 —— 只调"多磨砂"，不调"变亮镜面"。 */
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * n, y = Math.random() * n, rad = n * (0.12 + Math.random() * 0.26);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const bright = Math.random() > 0.5;
    g.addColorStop(0, bright ? 'rgba(236,236,236,0.75)' : 'rgba(150,150,150,0.55)');
    g.addColorStop(1, bright ? 'rgba(236,236,236,0)' : 'rgba(150,150,150,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2.5, 3.4);
  return t;
}

/* 手绘感的波浪分隔线：中间一条起伏的线，两端各一颗小圆点 */
function wavyRule(ctx, cx, y, halfW, amp, color, rnd) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = cx - halfW + t * halfW * 2;
    const yy = y + Math.sin(t * Math.PI * 3.1 + rnd() * 0.5) * amp;
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  for (const d of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + d * (halfW + 7), y, 2.8, 0, TAU);
    ctx.fill();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   卡片贴图：在浏览器里现场画一张磨砂玻璃卡片
   磨砂玻璃的质感来自五件事，缺一件就会退回成"塑料片"或者"一张纸"：
     · 断面是亮的 —— 光从边上溢出来，而不是一圈厚暗边；
     · 边缘有聚光 —— 从轮廓往里一层层淡下去的柔光带，这是亚克力的签名；
     · 面是奶白半透 + 有砂粒、有云絮 —— 背光透上来，但看得出是块玻璃；
     · 画面是「印」上去的 —— 影子短而软，底子半透，纸纹换成喷砂颗粒；
     · 内容留白够，周围有几颗散点，不然会空。
   hi = 放大态专用：分辨率 ×CARD_TEX_HI，留白（板面）改用另一套画法。
     平时卡片是半透的 —— 背后就是灯，透光才好看；被"拿到眼前"时背后是暗房间，
     所以放大态要做的是把留白压冷、压暗一档，让它读成"手指间那块玻璃"
     而不是"画面外面的白相框"（详见 1a / 1b 的注释）。
     注意放大态仍然是"磨砂"而不是"纸"：颗粒、云絮、边缘聚光一样不少。
   ═══════════════════════════════════════════════════════════════════════ */
function paintCard(card, seed, img, hi) {
  const mul = hi ? CARD_TEX_HI : 1;
  const opaque = !!hi;
  const cv = document.createElement('canvas');
  cv.width = CARD_TEX.w * mul;
  cv.height = CARD_TEX.h * mul;
  /* 关键：绘图坐标系锁在 CARD_UNIT，下面每一个数字都按 256×384 写。
     这里一次性缩放，分辨率就变成纯粹的旋钮，且放大态不会改变任何排版。 */
  const W = CARD_UNIT.w, H = CARD_UNIT.h;
  const ctx = cv.getContext('2d');
  ctx.scale(cv.width / W, cv.height / H);
  const rnd = rngFrom(seed);
  const tone = PALETTE[card.tone] || PALETTE.cream;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const R_OUT = 26;                                  // 板子圆角
  const BX = 1.6, BY = 1.6, BW = W - 3.2, BH = H - 3.2;   // 板的外轮廓

  /* 1a) 断面。磨砂玻璃的断面是"亮"的 —— 光从断面进去、在板子里乱窜，
         最后从边上溢出来。但**外轮廓不能整圈都是亮的**：一整圈亮边会让卡片糊在
         一起，三十六张读成一片。所以这里把两件事分开做：
           · 断面主体保持暗 —— 只负责把这张卡从背景和邻卡里切出来；
           · 亮的一条收窄成紧贴板面的细线，光感交给下面 1b-2 的板内辉光。
         放大态是唯一的例外：那时卡片是"一件单独的东西"、旁边没有邻卡要区分，
         所以断面反而要亮起来（左右两条最亮），否则整块板读不出厚度。 */
  roundRect(ctx, BX, BY, BW, BH, R_OUT);
  if (opaque) {
    /* ★ 放大态的断面**必须是亮的**，而且两侧最亮。
       亚克力被举到眼前时，光从左右两条断面切进去，那两条边会透出一条细亮线 ——
       这是"这是一块板"最省、也最不容易认错的一条证据。
       上一版这里和平时一样只刷一层半透明暗色（那层只负责"把卡从邻卡里切出来"），
       于是放大之后整块看起来像一张厚纸：没有断面，就没有厚度，也就没有玻璃。 */
    const edgeBand = ctx.createLinearGradient(BX, 0, BX + BW, 0);
    edgeBand.addColorStop(0.000, 'rgba(178,200,226,0.70)');
    edgeBand.addColorStop(0.010, 'rgba(150,174,204,0.44)');
    edgeBand.addColorStop(0.021, 'rgba(30,26,38,0.54)');
    edgeBand.addColorStop(0.500, 'rgba(24,20,32,0.52)');
    edgeBand.addColorStop(0.979, 'rgba(30,26,38,0.54)');
    edgeBand.addColorStop(0.990, 'rgba(150,174,204,0.44)');
    edgeBand.addColorStop(1.000, 'rgba(178,200,226,0.70)');
    ctx.fillStyle = edgeBand;
  } else {
    /* ★ 2026-10-06 空卡灯牌化：这层暗底原本给"有画面的卡"压外圈落差，
       空卡时代它就是卡的外圈读感，提到冷中灰 —— 保留"切得出来"的
       轮廓深度，但不再压成灰黑框。 */
    ctx.fillStyle = 'rgba(88,92,110,0.45)';
  }
  ctx.fill();

  const inset = 5.2;
  const PX = BX + inset, PY = BY + inset, PW = BW - inset * 2, PH = BH - inset * 2;

  /* 1a-2) 板面内缘那一道细亮线。线宽必须明显小于边厚（2.2 < 5.2），
           否则会把整条断面涂亮 —— 那就又回到"一片糊"了。
           顶亮、底转冷，因为头顶是暖光、下面反的是环境。 */
  const edgeG = ctx.createLinearGradient(0, PY, 0, PY + PH);
  if (opaque) {
    /* 放大态：紧贴板面这一圈是全场最亮的一根线 —— 它是"光从断面灌进来"的收口。
       颜色也要跟着板面一起转冷；暖白压冷底会出来一圈发黄的膜。 */
    edgeG.addColorStop(0.00, 'rgba(255,255,255,0.88)');
    edgeG.addColorStop(0.32, 'rgba(238,250,255,0.68)');
    edgeG.addColorStop(0.76, 'rgba(214,236,255,0.48)');
    edgeG.addColorStop(1.00, 'rgba(196,222,252,0.42)');
  } else {
    edgeG.addColorStop(0.00, 'rgba(255,252,247,0.66)');
    edgeG.addColorStop(0.32, 'rgba(255,246,232,0.44)');
    edgeG.addColorStop(0.76, 'rgba(232,238,250,0.30)');
    edgeG.addColorStop(1.00, 'rgba(212,222,246,0.26)');
  }
  ctx.strokeStyle = edgeG;
  ctx.lineWidth = opaque ? 2.8 : 2.2;
  roundRect(ctx, PX, PY, PW, PH, R_OUT - inset);
  ctx.stroke();

  /* 1b) 板面本体。磨砂是"奶白半透"，不是抛光那种清透 —— 不透明度必须
         明显高于抛光版（原来只有 0.13~0.16，那是玻璃，不是磨砂）。
         中段掺一点本张卡的色相：三十六张板面若是一模一样的奶白，
         整盏灯看起来就是同一张卡复印了三十六份。 */
  roundRect(ctx, PX, PY, PW, PH, R_OUT - inset);
  const acr = ctx.createLinearGradient(PX, PY, PX + PW, PY + PH);
  if (opaque) {
    /* ★ 放大态的板面**不能是实心奶白**。
       上一版这里是 alpha 0.97 的实心白，理由是"背后是空场，半透会浑浊"——
       那个担心是多余的：画面（印刷层）永远不透明，字一直读得清。
       被"实心白"杀掉的只有玻璃感，而玻璃感其实来自三件事：
         · 板面比画面**暗一档、冷一档**（奶白 → 冷青白）。这个落差正是
           "墨印在玻璃上"和"白纸上印了张画"的分界；
         · 卡面上要有**跨过画面的反射**（见 3c）—— 反射比不透明更能说明
           "前面还隔着一层"；
         · 边要看得见厚度（见 3d，以及放大态那道断面）。
       所以这里做的是"压冷、提亮、拉开与画面的落差"，而不是去追字面上的
       "更透明"：板面背后是暗房间，真透下去只会变成一圈黑框。
       （顺带记一笔：几层叠加之后这张贴图的实际 alpha 会累积到 0.9 上下，
       所以"透"从来不是靠改一个 alpha 完成的。） */
    /* ★ 底面必须是**冷青灰**，不是奶白。
       上一版这里是 alpha 0.62 的暖白，结果整圈留白读成了"画面外面套了个白相框"——
       塑料感就是从这儿来的。真实情况正好相反：手指间那块玻璃**比画面暗一档**，
       而且偏冷（短波散射得更开），只有紧贴断面的窄窄一圈被光打亮。
       所以底子压冷压暗，"玻璃"才从"白框"里分出来。
       （仍然不是靠 alpha 去做"透明"：板面背后是暗房间，真透下去只会变成一圈黑框。
        拉开与画面的明暗差、加上 3c 的反射和 3d 的厚度影，才是玻璃） */
    /* 底面冷、中段暗、边上亮 —— 这三条一起才读成"玻璃"，只压暗会读成灰塑料。
       RGB 给得偏亮（近白）是故意的：它要的是被那盏阅读灯一照就"亮起来"，
       真正的暗是靠 alpha 让背景透下去、以及中段那段冷色往下压。 */
    acr.addColorStop(0.00, 'rgba(186,208,230,0.30)');
    acr.addColorStop(0.44, tint(tone.fill, 0.62, 0.22));
    acr.addColorStop(1.00, 'rgba(150,176,204,0.27)');
  } else {
    /* 留白要"奶白"，不能"脏"。k 是往白里冲的量。
       ★ 2026-10-06 两轮定稿（色板换浅色 + 空卡当灯牌）：
       ① 新色板 fill 本身 L≈94%，照旧冲 0.93 的白会被洗成纯白；
       ② 空卡整张都是留白 —— 旧设计里留白垫在暗底上给"有画面的卡"压落差，
         空卡没画面，灰底直接变成整张卡的读感（实测截图：整盏灯灰蒙蒙）。
       所以：k 收到 0.45 / 0.30 保住色相，alpha 抬到 0.62 / 0.66 遮住暗房间，
       首档白也提到 0.42。 */
    acr.addColorStop(0.00, 'rgba(255,255,255,0.42)');
    acr.addColorStop(0.40, tint(tone.fill, 0.45, 0.62));
    acr.addColorStop(1.00, tint(tone.fill, 0.30, 0.66));
  }
  ctx.fillStyle = acr;
  ctx.fill();

  ctx.save();
  roundRect(ctx, PX, PY, PW, PH, R_OUT - inset);
  ctx.clip();

  /* 1b-2) 边缘聚光 —— 亚克力最认得出来、也最省的一条线索。
           做法是从轮廓往里叠十几道逐渐变淡的细线，等于手工堆出一条
           有衰减的柔光带。一笔宽描边会硬得像边框，这样才像"光渗进来"。
           这一整段被 clip 在板面内，所以它只管把玻璃点亮，绝不碰外面那圈暗轮廓 ——
           "切得出来"和"边上透光"这两件事必须由不同的层各自负责。 */
  /* 放大态要收得比平时更紧、但更亮：14 道 0.46 的暖白铺开 19 单位会刷成一片白
     （那就是"塑料相框"）；可压到 0.24 又变成一圈灰。真正对的是
     "窄而亮" —— 光从断面渗进来只能走一小段，所以贴着边那一窄条白，
     往里迅速收掉，中段留暗。这条明暗落差就是玻璃的读法。 */
  const glowA = opaque ? 0.44 : 0.30;
  const glowSpan = opaque ? 12 : 19;
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    const g = t * glowSpan;
    ctx.globalAlpha = Math.pow(1 - t, 2.1) * glowA;
    ctx.lineWidth = 2.6;
    /* 放大态把光调冷：暖白叠在冷底子上会互相打架，出来是一层发黄的膜 */
    ctx.strokeStyle = opaque ? 'rgba(238,248,255,1)' : 'rgba(255,252,246,1)';
    roundRect(ctx, PX + g, PY + g, PW - g * 2, PH - g * 2,
      Math.max(4, R_OUT - inset - g));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  /* 1b-3) 磨砂的两层：细颗粒（喷砂面）+ 云絮（雾得轻重不一）。
           少了云絮，整片板会均匀得像贴了一层磨砂膜 —— 那是塑料，不是玻璃。 */
  ctx.globalAlpha = opaque ? 0.20 : 0.24;
  ctx.fillStyle = frostPattern(ctx, cv.width / W);
  ctx.fillRect(PX, PY, PW, PH);
  ctx.globalAlpha = opaque ? 0.14 : 0.16;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = mottlePattern(ctx, cv.width / W, seed);
  ctx.fillRect(PX, PY, PW, PH);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  /* 1b-4) 顶边受光：只有上面这一条比别处亮。上下亮暗一有差别，
           眼睛就自动读成"一个朝上放着、有厚度的片"。 */
  const topLit = ctx.createLinearGradient(0, PY, 0, PY + PH * 0.13);
  topLit.addColorStop(0.0, 'rgba(255,255,255,' + (opaque ? 0.30 : 0.52) + ')');
  topLit.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = topLit;
  ctx.fillRect(PX, PY, PW, PH * 0.13);
  ctx.restore();

  /* 1c) 两道斜向反光带。磨砂面是漫射的，它不会像抛光亚克力那样把光原样弹
         回来 —— 所以带子要更宽、更淡：读起来不是"一条亮线"，而是
         "这个角度上它整体亮了一点"。 */
  ctx.save();
  roundRect(ctx, PX, PY, PW, PH, R_OUT - inset);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  const band = (x0, w, alpha) => {
    ctx.beginPath();
    ctx.moveTo(x0, PY); ctx.lineTo(x0 + w, PY);
    ctx.lineTo(x0 + w - PH * 0.30, PY + PH); ctx.lineTo(x0 - PH * 0.30, PY + PH);
    ctx.closePath();
    const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    g.addColorStop(0.0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,' + alpha + ')');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fill();
  };
  band(W * 0.03, W * 0.23, opaque ? 0.13 : 0.11);
  band(W * 0.31, W * 0.08, opaque ? 0.07 : 0.06);
  ctx.restore();

  /* 2) 印刷层：稍微歪一点，手工感。
        磨砂玻璃上的画面不是"贴了张纸"，而是"印在玻璃上"——
        所以影要短要软、纸纹换成喷砂颗粒。但**画面本身必须清楚**：
        磨砂感交给玻璃那圈留白和材质的高光去表达，
        画面再跟着一起雾掉，就只是"糊"，不是"磨砂"。 */
  /* 放大态把印刷层收窄（28 → 36）。留白就是"玻璃露出来的那一圈"，
     它就是玻璃感的载体 —— 全屏看的时候这一圈差一点点都很明显。 */
  const pad = opaque ? 36 : 28;
  const sw = W - pad * 2, sh = H - pad * 2;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((rnd() - 0.5) * 0.052);
  ctx.translate(-W / 2, -H / 2);

  /* 2a) 印刷底。这里有一个决定"贴上去"还是"印进去"的分岔：
         深色投影读作"一张纸浮在玻璃上面"，浅色外溢读作"墨在玻璃里面、被玻璃漫开"。
         所以深影压到很轻（0.22），另外补一圈白色外溢 —— 后者才是"印在玻璃里"。
         白边给到 0.80 而不是全透：这圈白是画面和玻璃之间的分界，
         太透它就没形了，画面的边缘会跟着发虚。 */
  ctx.save();
  ctx.shadowColor = 'rgba(38,28,48,0.22)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetX = 1.4;
  ctx.shadowOffsetY = 2.0;
  roundRect(ctx, pad - 2.6, pad - 2.6, sw + 5.2, sh + 5.2, 26);
  ctx.fillStyle = opaque ? '#FFFFFF' : 'rgba(255,255,255,0.80)';
  ctx.fill();
  ctx.restore();
  /* 白色外溢：把画面边缘往玻璃里"化"开一圈。没有它，画面上就永远
     压着一道硬边，"印在玻璃里"这件事立不住。 */
  ctx.save();
  ctx.globalAlpha = opaque ? 0.20 : 0.18;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 7;
  roundRect(ctx, pad, pad, sw, sh, 22);
  ctx.stroke();
  ctx.restore();

  /* 2b) 色块本体：顶部亮、底部沉一点 —— 纯色块会显得很薄。
         非放大态只留 5%~10% 的透（alpha 0.95~0.90），刚好够"玻璃在下面"，
         再多就把色相冲淡、字也发灰。磨砂感由外面那圈玻璃留白和材质的高光
         去表达 —— 画面不该跟着一起雾掉。 */
  roundRect(ctx, pad, pad, sw, sh, 22);
  const body = ctx.createLinearGradient(pad, pad, pad, pad + sh);
  if (opaque) {
    body.addColorStop(0.00, shade(tone.fill, 0.12));
    body.addColorStop(0.52, tone.fill);
    body.addColorStop(1.00, shade(tone.fill, -0.14));
  } else {
    /* ★ 2026-10-06 浅色灯牌：顶部的白冲多一点（顶部亮）、
       底部的压暗收轻（-0.13 会把浅色板 bottom 拽成灰绿）。 */
    body.addColorStop(0.00, tint(tone.fill, 0.28, 0.95));
    body.addColorStop(0.52, tint(tone.fill, 0.00, 0.93));
    body.addColorStop(1.00, tint(tone.fill, -0.06, 0.92));
  }
  ctx.fillStyle = body;
  ctx.fill();

  /* 2c) 印刷面的质感：同一套喷砂颗粒 + 顶部内侧的一点点暗。
         这里刻意不用 paperNoise 那套纸纹 —— 纸纹会立刻把材质拉回"纸张"。 */
  ctx.save();
  roundRect(ctx, pad, pad, sw, sh, 22);
  ctx.clip();
  ctx.globalAlpha = opaque ? 0.34 : 0.28;
  ctx.fillStyle = frostPattern(ctx, cv.width / W);
  ctx.fillRect(pad, pad, sw, sh);
  ctx.globalAlpha = 1;
  const press = ctx.createLinearGradient(0, pad, 0, pad + sh * 0.18);
  press.addColorStop(0, 'rgba(58,44,52,0.13)');
  press.addColorStop(1, 'rgba(58,44,52,0)');
  ctx.fillStyle = press;
  ctx.fillRect(pad, pad, sw, sh * 0.18);
  ctx.restore();

  /* 2d) 内缘一圈亮边：印刷边缘会有一道压印造成的亮线。
         但不能亮成描边 —— 0.5 以下，够读出"这里有界"就行。 */
  ctx.strokeStyle = 'rgba(255,255,255,0.50)';
  ctx.lineWidth = 1.8;
  roundRect(ctx, pad + 1.2, pad + 1.2, sw - 2.4, sh - 2.4, 21);
  ctx.stroke();

  /* 3) 贴纸上的内容：图 + 手写字 */
  const hasArt = card.art && ART[card.art] && card.art !== 'text';
  const lines = String(card.text || '').split('\n').filter((l) => l.length);
  const cx = W / 2;

  if (img) {
    /* 传了自己的图片：等比铺满贴纸区，圆角裁切 */
    const boxW = sw * 0.94;
    const boxH = lines.length ? sh * 0.60 : sh * 0.86;
    const boxY = pad + (lines.length ? sh * 0.06 : sh * 0.07);
    const iw = img.width || img.naturalWidth || 1;
    const ih = img.height || img.naturalHeight || 1;
    const k = Math.max(boxW / iw, boxH / ih);
    const dw = iw * k, dh = ih * k;
    ctx.save();
    roundRect(ctx, cx - boxW / 2, boxY, boxW, boxH, 18);
    ctx.clip();
    ctx.drawImage(img, cx - dw / 2, boxY + (boxH - dh) / 2, dw, dh);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 3;
    roundRect(ctx, cx - boxW / 2, boxY, boxW, boxH, 18);
    ctx.stroke();
    if (lines.length) {
      drawHandBlock(ctx, lines, cx, boxY + boxH + sh * 0.17, sw * 0.86, 26, tone.ink, rnd, 1.3);
    }
  } else if (hasArt) {
    const artBox = Math.min(sw * 0.86, 140);
    const artY = pad + sh * 0.345;
    /* 图案底下先铺一团柔光：图案因此像是浮在印刷层上，而不是印上去的。
       底子改成半透之后这团光要更实一点，不然图案会和背后的玻璃糊在一起。
       放大态不铺 —— 那里的板面本身已经是实心奶白，再叠一圈白只会变成怪圈。 */
    if (!opaque) {
      const halo = ctx.createRadialGradient(cx, artY, artBox * 0.08, cx, artY, artBox * 0.66);
      halo.addColorStop(0.0, 'rgba(255,255,255,0.58)');
      halo.addColorStop(0.6, 'rgba(255,255,255,0.24)');
      halo.addColorStop(1.0, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, artY, artBox * 0.66, 0, TAU);
      ctx.fill();
    }

    ART[card.art](ctx, cx, artY, artBox, tone);
    if (lines.length) {
      /* 手绘波浪线代替一条直线，两端用小圆点收口 */
      ctx.save();
      ctx.globalAlpha = 0.62;
      wavyRule(ctx, cx, pad + sh * 0.655, sw * 0.20, 2.2, tone.accent, rnd);
      ctx.restore();
      drawHandBlock(ctx, lines, cx, pad + sh * 0.835, sw * 0.86, 32, tone.ink, rnd, 1.34);
    }
  } else if (lines.length) {
    /* ★ 2026-10-12 一行字数太少（反馈：「一行就几个字，看得难受」）：
       2026-10-10 那版先按 38 号折行、再按行数回推字号 —— 折行与落笔
       用了两个字号：40 字留言被折成 ~4 字一行，字号回推到 23 以后每行
       只占半个卡宽，读起来是一窄列小字。
       现在从大字号往小试：每个候选字号都按 maxW 重新折行，块高
       （行数 × gap × 字号）放得下就用它 —— 折行与落笔同一个字号，
       行宽永远撑满，字号也是撑满前提下最大的那个。
       起点 40：留言落款「——阿玥」这类 4 字行在 40 时刚好不折
       （4×40×0.99=158 ≤ maxW=168），再大就把落款拆成两行。 */
    const maxW = sw * 0.84, gap = 1.46;
    const avail = H * 0.78;                 // 板面可用高度（上下留白）
    let s = 40;
    let wrapped = wrapLines(ctx, lines, maxW, s);
    while (s > 13 && wrapped.length * gap * s > avail) {
      s -= 2;
      wrapped = wrapLines(ctx, lines, maxW, s);
    }
    drawHandBlock(ctx, wrapped, cx, H / 2 + 4, maxW, s, tone.ink, rnd, gap);
  }

  /* 3b) 底部三颗渐隐的小点：整张卡不填满才透气，但也不能空 */
  ctx.fillStyle = tone.accent;
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.52 - i * 0.12;
    ctx.beginPath();
    ctx.arc(cx + (i - 1) * 12.5, pad + sh * 0.975, 3.2, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  /* 3c) ★ 玻璃面上的反射 —— 这一层必须画在**画面之上**。
        前面 1c 那两道反光带画在印刷层下面，等于只在"玻璃留白"那一圈上起作用，
        画面本身完全没被反光碰过 —— 而"隔着一层玻璃看"最直接的证据，
        恰恰是反射跨过画面一起压上来。少这一层，放得再大也只是"一张平板上的图案"。
        两样东西：一道宽的斜向柔光（这个角度下整块亮了一点），
        一条竖向的光柱（房间里那盏灯在玻璃上的倒影）。
        alpha 压得很低：反射一超过 0.14，画面就开始发灰。 */
  ctx.save();
  roundRect(ctx, PX, PY, PW, PH, R_OUT - inset);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  const glassSheen = ctx.createLinearGradient(PX - PW * 0.10, PY + PH * 0.66, PX + PW * 1.05, PY + PH * 0.14);
  glassSheen.addColorStop(0.00, 'rgba(255,255,255,0)');
  glassSheen.addColorStop(0.44, 'rgba(255,252,246,' + (opaque ? 0.145 : 0.062) + ')');
  glassSheen.addColorStop(0.66, 'rgba(255,255,255,0)');
  ctx.fillStyle = glassSheen;
  ctx.fillRect(PX, PY, PW, PH);

  ctx.beginPath();
  ctx.moveTo(PX + PW * 0.20, PY);
  ctx.lineTo(PX + PW * 0.50, PY);
  ctx.lineTo(PX + PW * 0.66, PY + PH);
  ctx.lineTo(PX + PW * 0.28, PY + PH);
  ctx.closePath();
  const pillar = ctx.createLinearGradient(PX + PW * 0.22, 0, PX + PW * 0.58, 0);
  pillar.addColorStop(0.00, 'rgba(224,240,255,0)');
  pillar.addColorStop(0.46, 'rgba(224,240,255,' + (opaque ? 0.17 : 0.075) + ')');
  pillar.addColorStop(1.00, 'rgba(224,240,255,0)');
  ctx.fillStyle = pillar;
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  /* 3d) 板面的"厚度内影"：紧贴边缘往里压一道很窄的柔暗。
       作用是让半透的板面从暗色断面上立起来一层 —— 少了它，
       板面和断面会连成一片，刚做出来的那点厚度立刻又没了。
       必须窄、必须淡：宽一点就变成画框，脏。 */
  ctx.lineWidth = 6;
  ctx.strokeStyle = opaque ? 'rgba(16,20,32,0.20)' : 'rgba(16,14,24,0.24)';
  roundRect(ctx, PX + 10, PY + 10, PW - 20, PH - 20, Math.max(4, R_OUT - inset - 10));
  ctx.stroke();
  ctx.restore();

  /* 4) 顶部的挂孔：外圈亮边 + 内圈暗，看起来才像个真的洞。
        磨砂玻璃的孔和抛光的不一样 —— 孔周围会有一圈"光被挤到这儿来"的晕，
        补上它，孔就不是挖出来的一个黑洞，而是玻璃上一个真的穿孔。 */
  const holeY = 27, holeR = 6.6;
  const holeHalo = ctx.createRadialGradient(W / 2, holeY, holeR * 0.7, W / 2, holeY, holeR * 2.7);
  holeHalo.addColorStop(0.0, 'rgba(255,252,248,0.34)');
  holeHalo.addColorStop(0.55, 'rgba(255,250,240,0.14)');
  holeHalo.addColorStop(1.0, 'rgba(255,250,240,0)');
  ctx.fillStyle = holeHalo;
  ctx.beginPath();
  ctx.arc(W / 2, holeY, holeR * 2.7, 0, TAU);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(W / 2, holeY, holeR, 0, TAU);
  ctx.fillStyle = 'rgba(22,18,26,0.55)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.72)';
  ctx.lineWidth = 2.4;
  ctx.stroke();
  /* 孔口上沿的一道反光，像是被金属环压出来的 */
  ctx.beginPath();
  ctx.arc(W / 2, holeY + 0.6, holeR * 0.78, Math.PI * 1.12, Math.PI * 1.88);
  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  return cv;
}

/* ═══════════════════════════════════════════════════════════════════════
   默认卡片内容 —— 想换文案 / 图案，改这个数组就行
   art 可选值：cat bear crown star flower sun heart moon cloud smile fish text
   tone 可选值：pink butter mint sky lilac peach aqua cream coral lime ink
   text 里的 \n 表示换行
   ═══════════════════════════════════════════════════════════════════════ */
const DEFAULT_CARDS = [
  { text: '新的一天\n也要发光', art: 'sun',    tone: 'butter' },
  { text: '慢慢来\n比较快',     art: 'text',   tone: 'mint' },
  { text: '今天也要\n开心呀',   art: 'cat',    tone: 'pink' },
  { text: '万事顺遂\n平安喜乐', art: 'crown',  tone: 'cream' },
  { text: '你超棒的',           art: 'star',   tone: 'sky' },
  { text: '记得\n多喝水',       art: 'fish',   tone: 'aqua' },
  { text: '宇宙很大\n先睡一觉', art: 'moon',   tone: 'lilac' },
  { text: '别着急\n会好的',     art: 'cloud',  tone: 'sky' },
  { text: '好事\n会发生',       art: 'smile',  tone: 'butter' },
  { text: '心想事成',           art: 'flower', tone: 'pink' },
  { text: '保持热爱\n奔赴山海', art: 'text',   tone: 'peach' },
  { text: '开心\n每一天',       art: 'bear',   tone: 'coral' },
  { text: '一切顺遂\n万事胜意', art: 'heart',  tone: 'pink' },
  { text: '慢慢变好',           art: 'cat',    tone: 'lime' },
  { text: '今天也要\n加油鸭',   art: 'star',   tone: 'aqua' },
  { text: '睡个\n好觉',         art: 'moon',   tone: 'ink' },
  { text: '日子\n甜甜的',       art: 'heart',  tone: 'coral' },
  { text: '风会吹走\n不开心',   art: 'text',   tone: 'lilac' },
  { text: '平安喜乐',           art: 'cloud',  tone: 'cream' },
  { text: '每天都\n值得期待',   art: 'sun',    tone: 'peach' },
  { text: '慢慢喜欢\n这个世界', art: 'flower', tone: 'lime' },
  { text: '要好好的',           art: 'bear',   tone: 'butter' },
  { text: '愿望\n都成真',       art: 'crown',  tone: 'lilac' },
  { text: '早点休息',           art: 'text',   tone: 'ink' },
];

/* ═══════════════════════════════════════════════════════════════════════
   程序化生成的几张贴图与材质
   ═══════════════════════════════════════════════════════════════════════ */

/* 环境反射贴图：金属好不好看，九成靠它。一张竖渐变就够 */
function makeEnvTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#525c72');   // 头顶的天光（冷）
  g.addColorStop(0.30, '#262a36');
  g.addColorStop(0.48, '#141620');   // 地平线压暗
  g.addColorStop(0.60, '#3f2c17');   // 地平线往下：一抹暖
  g.addColorStop(0.74, '#8a5a2b');   // 灯自己的暖光带
  g.addColorStop(0.88, '#3a2717');   // 底部也要留一点暖，不然环的下沿会黑成一块
  g.addColorStop(1.00, '#1a120a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 256);
  // 斜向的一道柔光，让拉伸后金属上出现一条长高光
  const s = ctx.createLinearGradient(0, 0, 64, 0);
  s.addColorStop(0.00, 'rgba(255,255,255,0)');
  s.addColorStop(0.34, 'rgba(255,240,215,0.22)');
  s.addColorStop(0.44, 'rgba(255,255,255,0)');
  ctx.fillStyle = s;
  ctx.fillRect(0, 60, 64, 90);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 径向光晕：用来替代昂贵的 Bloom */
function makeGlowTexture(core, mid, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.00, 'rgba(' + color + ',' + core + ')');
  g.addColorStop(0.16, 'rgba(' + color + ',' + mid + ')');
  g.addColorStop(0.44, 'rgba(' + color + ',0.18)');
  g.addColorStop(1.00, 'rgba(' + color + ',0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 放大态用的暗场：中间浅、四周深的一块面片贴图。
   做成贴图而不是一层 DOM，是因为 DOM 盖在画布上会连"被拿起来的卡片"一起压暗 ——
   这个必须只压背景。 */
function makeDimTexture() {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.64);
  g.addColorStop(0.00, 'rgba(4,3,6,0.10)');
  g.addColorStop(0.50, 'rgba(4,3,6,0.44)');
  g.addColorStop(1.00, 'rgba(4,3,6,0.86)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 放大态的卡片投影：一团软到看不出边界的暗。
   卡片被"拿到眼前"之后，背后空无一物，没有影子就会像贴纸一样浮在画面上。
   一圈柔和的黑压在它后面偏下的位置，物体立刻就落在了空间里。 */
function makeSoftShadowTexture() {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.00, 'rgba(3,2,5,0.72)');
  g.addColorStop(0.42, 'rgba(3,2,5,0.40)');
  g.addColorStop(0.72, 'rgba(3,2,5,0.13)');
  g.addColorStop(1.00, 'rgba(3,2,5,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 骨架材质预设：想换风格，改 createAcrylicLamp 的 frame 选项即可 */
const FRAME_PRESETS = {
  gunmetal: {   // 深炭灰枪铁：冷静、耐看，卡片会更突出
    frame:  { color: 0x424856, metalness: 1.0, roughness: 0.29, envMapIntensity: 1.25 },
    accent: { color: 0xb8934f, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.45 },
    wire:   { color: 0xa8aeba, metalness: 1.0, roughness: 0.18, envMapIntensity: 1.35 },
  },
  champagne: {  // 奶油白 + 香槟金：温柔、更像家居摆件
    frame:  { color: 0xe3d8c6, metalness: 0.9, roughness: 0.30, envMapIntensity: 1.2 },
    accent: { color: 0xc9a463, metalness: 1.0, roughness: 0.20, envMapIntensity: 1.4 },
    wire:   { color: 0xd9cfbc, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.25 },
  },
};

const BEAD_COLORS = [0xf6c445, 0x2c3145, 0xd4402f, 0xf3ece0, 0x2f5d46, 0x6b4a8f, 0xff8f6b];

/* 两点之间连一根圆柱 */
function strut(ax, ay, az, bx, by, bz, r, mat) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 7), mat);
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len)
  );
  return mesh;
}

/* ═══════════════════════════════════════════════════════════════════════
   主函数
   container : 容器元素；不传则挂到 body
   options   : { cards, autoSpin, frame, dust }
   ═══════════════════════════════════════════════════════════════════════ */
function createAcrylicLamp(container, options) {
  const opt = Object.assign(
    /* dpr：渲染分辨率上限，默认封到 2。3 倍屏手机上再多画像素肉眼看不出来，
       卡顿却很实在；手机上想更流畅可以传 1.5。 */
    { cards: DEFAULT_CARDS, autoSpin: 0.075, frame: 'gunmetal', dust: true, spin: true, dpr: 2 },
    options || {}
  );
  const host = container || document.body;
  const preset = FRAME_PRESETS[opt.frame] || FRAME_PRESETS.gunmetal;
  if (opt.font) CARD_FONT_USER = String(opt.font);   // 灯牌字体（见 cardFontStack 注释）

  /* ---------- 渲染器 ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opt.dpr || 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 3000);

  /* 环境反射：一次性烘成 PMREM，之后基本不耗性能 */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = makeEnvTexture();
  const envRT = pmrem.fromEquirectangular(envTex);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.85;
  envTex.dispose();
  pmrem.dispose();

  /* ---------- 灯光 ---------- */
  const hemi = new THREE.HemisphereLight(0xffe6c8, 0x0a0c14, 0.48);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffd6a6, 1.2);
  keyLight.position.set(70, 130, 55);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x8fb0ff, 1.15);   // 冷色轮廓光，深色金属能不能立起来全靠它
  rimLight.position.set(-85, 52, -70);
  scene.add(rimLight);

  /* 四层环拉开到 y=41~87 之后，一盏灯照不满全场：上下各放一盏分管上下两层，
     否则会出现「上面亮、下面暗」的断层 */
  const coreLight = new THREE.PointLight(0xffc47a, 1020, 520, 2);  // 灯芯（上段）
  coreLight.position.set(0, 70, 0);
  scene.add(coreLight);

  const lowLight = new THREE.PointLight(0xffb46a, 1180, 400, 2);   // 下段，专照底下两层的环和卡片
  lowLight.position.set(0, 34, 0);
  scene.add(lowLight);

  const topLight = new THREE.PointLight(0xfff0d6, 320, 260, 2);
  topLight.position.set(0, 96, 0);
  scene.add(topLight);

  /* ── 打灯：四套预设 ────────────────────────────────────────────────────
     换灯不能只换颜色 —— 那只读成"加了层滤镜"。真正要动的是这一整排一起：
     房间光（hemi）、主光与轮廓光的冷暖对比、灯芯自己的色温与亮度、
     曝光，以及 glow / haze / floor 三张"光"的贴图（灯芯辉光、笼罩整灯的雾光、
     地面那摊光）。前三样管"照到的东西"，后三样管"光本身长什么样" ——
     少了它们，月光档下地面还是一片橘，四档灯就只是同一张暖照片调了下曝光。
       warm   暖灯（默认）—— 灯芯暖、环境半暖，最像"钨丝灯罩着一层暖玻璃"；
       moon   月光 —— 顶光翻成冷蓝、灯芯压暗四成、地面与雾光一起转冷；
              冷暖对比全部来自"灯芯 vs 环境"，这是所有夜景照片的套路；
       day    自然光 —— 中性白 + 曝光抬高，白天放在窗边看到的样子；
       candle 烛光 —— 更暖更暗，灯芯与地面都推到橙红端，带一点点不规则的跳动。
     这张表是唯一的事实来源：初始值就是由 applyLight('warm') 写进去的。 */
  const LIGHT_PRESETS = {
    warm: {
      label: '暖灯',
      hemi: [0xffe6c8, 0x0a0c14, 0.48],
      key: [0xffd6a6, 1.20], rim: [0x8fb0ff, 1.15],
      core: [0xffc47a, 1020], low: [0xffb46a, 1180], top: [0xfff0d6, 320],
      glow: '255,199,138', haze: '255,168,88', floor: '255,168,94',
      exposure: 1.00, flicker: 0,
    },
    moon: {
      label: '月光',
      /* 月光不是"把颜色调冷"就完事 —— 真正读作月光的组合是
         「曝光压下去 + 冷暖对比拉大」：整体变暗，同时那盏灯芯反而更突出。 */
      hemi: [0x93aee6, 0x06080f, 0.32],
      key: [0xa9c6ff, 0.72], rim: [0xc6d8ff, 1.85],
      core: [0xffcf9a, 560], low: [0xffc182, 700], top: [0xd8e4ff, 230],
      glow: '255,186,124', haze: '128,162,220', floor: '132,166,222',
      exposure: 0.92, flicker: 0,
    },
    day: {
      label: '自然光',
      hemi: [0xffffff, 0x141821, 0.72],
      key: [0xfff7ea, 1.55], rim: [0xdce8ff, 0.80],
      core: [0xfff0d6, 880], low: [0xfff0d6, 960], top: [0xfffaf0, 420],
      glow: '255,226,190', haze: '246,240,226', floor: '244,238,220',
      exposure: 1.10, flicker: 0,
    },
    candle: {
      label: '烛光',
      /* 烛光的要点是"暗"和"偏红"，不是"更暖"：曝光压到 0.86、
         灯芯挪到橙红端，跳动幅度也加大一档（0.16 → 0.22）。 */
      hemi: [0xffd0a0, 0x07050a, 0.26],
      key: [0xffbf7a, 0.85], rim: [0x6f86c8, 0.70],
      core: [0xff9a3c, 760], low: [0xff8a30, 900], top: [0xffd8a0, 210],
      glow: '255,146,64', haze: '255,112,34', floor: '255,104,28',
      exposure: 0.86, flicker: 0.22,
    },
  };
  let lightCfg = LIGHT_PRESETS.warm;
  let coreBase = lightCfg.core[1];   // 灯芯基准亮度：tick 里再乘呼吸和跳动
  let lowBase = lightCfg.low[1];

  function applyLight(name) {
    const p = LIGHT_PRESETS[name] || LIGHT_PRESETS.warm;
    lightCfg = p;
    hemi.color.setHex(p.hemi[0]);
    hemi.groundColor.setHex(p.hemi[1]);
    hemi.intensity = p.hemi[2];
    keyLight.color.setHex(p.key[0]);  keyLight.intensity = p.key[1];
    rimLight.color.setHex(p.rim[0]);  rimLight.intensity = p.rim[1];
    coreLight.color.setHex(p.core[0]);
    coreBase = p.core[1];
    lowLight.color.setHex(p.low[0]);
    lowLight.intensity = p.low[1];
    lowBase = p.low[1];
    topLight.color.setHex(p.top[0]);  topLight.intensity = p.top[1];
    renderer.toneMappingExposure = p.exposure;
    /* ★ 只换灯是不够的。房间里真正占面积的三样东西 —— 灯芯那团辉光、
       罩住整盏灯的一层雾光、地面上那一摊暖光 —— 都是画在贴图上的，
       跟灯的颜色无关。它们不动，四档灯在画面里就只是"同一张暖照片调了下曝光"。
       这一层装好之后（在场景骨架那一节）才接手。 */
    if (repaintGlows) repaintGlows(p);
    api.light = name;
    if (typeof api.onLight === 'function') api.onLight(name);
  }

  /* 场景骨架建好之后装上：把三张"光的颜色"重画一遍 */
  let repaintGlows = null;

  /* ---------- 材质 ---------- */
  const matFrame = new THREE.MeshStandardMaterial(preset.frame);
  const matAccent = new THREE.MeshStandardMaterial(preset.accent);
  const matWire = new THREE.MeshStandardMaterial(preset.wire);
  /* 珠子做成"刻面水晶"。两条：
     ① 几何本身是切面体（见下面的 beadBigGeo），配上 flatShading ——
        每一面各自反光，灯一转就一颗一颗地闪，这是圆球做不到的；
     ② iridescence 给一点点彩虹边。真正的宝石火彩来自色散，
        但那要开 transmission（等于每帧多渲一整遍场景），
        而这些珠子在屏幕上只有十几像素，色散根本看不出来 ——
        所以这里用虹彩来"演"色散，代价几乎为零。
     不做全透还有第二个理由：珠子是坠在暗背景里的，全透会直接"消失"。 */
  const matBeads = BEAD_COLORS.map(
    (c) => new THREE.MeshPhysicalMaterial({
      color: c, metalness: 0.0, roughness: 0.05,
      flatShading: true,
      clearcoat: 1, clearcoatRoughness: 0.02,
      iridescence: 0.36, iridescenceIOR: 1.42,
      iridescenceThicknessRange: [110, 400],
      envMapIntensity: 2.7, specularIntensity: 1.0,
    })
  );
  const matBeadSteel = new THREE.MeshStandardMaterial({ color: 0xc4cad6, metalness: 1.0, roughness: 0.14, envMapIntensity: 1.7 });

  const glowTex = makeGlowTexture(1.0, 0.58, '255,214,150');
  const hazeTex = makeGlowTexture(0.42, 0.20, '255,168,88');
  const floorTex = makeGlowTexture(0.62, 0.26, '255,168,94');

  const matCore = new THREE.MeshBasicMaterial({ color: 0xffeccb, toneMapped: false });
  const matGlass = new THREE.MeshPhysicalMaterial({
    color: 0xfff2dc, transparent: true, opacity: 0.14, roughness: 0.05, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide, depthWrite: false,
  });

  /* ---------- 场景骨架 ---------- */
  const root = new THREE.Group();
  scene.add(root);
  const statics = new THREE.Group();   // 底座 + 灯杆：不转
  const head = new THREE.Group();      // 灯头：整体缓慢自转
  root.add(statics, head);

  /* 底座 */
  const base = new THREE.Mesh(new THREE.CylinderGeometry(CFG.base.r, CFG.base.r * 1.08, CFG.base.h, 56), matFrame);
  base.position.y = CFG.base.h / 2;
  statics.add(base);
  const baseTrim = new THREE.Mesh(new THREE.TorusGeometry(CFG.base.r, 0.62, 12, 72), matAccent);
  baseTrim.rotation.x = -Math.PI / 2;
  baseTrim.position.y = CFG.base.h + 0.2;
  statics.add(baseTrim);

  /* 灯杆：一路顶到伞骨汇聚点 */
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(CFG.pole.r, CFG.pole.r * 1.3, CFG.pole.to, 20), matFrame);
  pole.position.y = CFG.pole.to / 2;
  statics.add(pole);
  [8, 16].forEach((y) => {
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 1.4, 24), matAccent);
    collar.position.y = y;
    statics.add(collar);
  });

  /* 灯芯：一根贯穿上下的光柱。四层卡片都靠它亮起来 */
  const filament = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 72, 28), matCore);
  filament.position.y = 50;
  statics.add(filament);

  const glassTube = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 78, 40, 1, true), matGlass);
  glassTube.position.y = 50;
  statics.add(glassTube);

  /* 光晕：两层 sprite，一层紧一层散 */
  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false,
  }));
  glowSprite.scale.set(84, 84, 1);
  glowSprite.position.y = 52;
  glowSprite.renderOrder = 3;
  statics.add(glowSprite);

  const hazeSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: hazeTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5, toneMapped: false,
  }));
  hazeSprite.scale.set(252, 252, 1);
  hazeSprite.position.y = 48;
  hazeSprite.renderOrder = 2;
  statics.add(hazeSprite);

  /* 地面那摊暖光 */
  const floorGlow = new THREE.Mesh(
    new THREE.CircleGeometry(150, 72),
    new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false, opacity: 0.9, toneMapped: false })
  );
  floorGlow.rotation.x = -Math.PI / 2;
  floorGlow.position.y = 0.04;
  floorGlow.renderOrder = 1;
  statics.add(floorGlow);

  /* 三张"光"的贴图跟着预设重画。参数 (core, mid, 'r,g,b') 和上面三处初始值一一对应，
     换档时旧贴图要 dispose，否则连着按几次就漏了几张 canvas。 */
  repaintGlows = (p) => {
    const repaint = (obj, core, mid, color) => {
      if (!obj || !obj.material) return;
      obj.material.map.dispose();
      obj.material.map = makeGlowTexture(core, mid, color);
      obj.material.needsUpdate = true;
    };
    repaint(glowSprite, 0.40, 0.15, p.glow);
    repaint(hazeSprite, 0.42, 0.20, p.haze);
    repaint(floorGlow, 0.62, 0.26, p.floor);
  };
  repaintGlows(lightCfg);

  /* 灯头：四层环 + 挂件 */
  const RINGS = CFG.rings;
  const TOP = CFG.pole.to;

  /* 四层环，一层比一层大、一层比一层低 */
  RINGS.forEach((ring, li) => {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(ring.r, ring.tube, 12, 120), matFrame);
    torus.rotation.x = -Math.PI / 2;
    torus.position.y = ring.y;
    head.add(torus);

    /* 每层用四根水平的细辐条连到中心柱上。
       这里刻意不用「从顶端一路通到最外环的长伞骨」—— 那样整盏灯会变成一个笼子，
       外层卡片把内层全挡住，观感很闷。水平辐条在侧视图里几乎只是一条线。 */
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + li * 0.24;   // 每层错开一点，四层的杆不会叠成一根
      head.add(strut(0, ring.y, 0, Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r, 0.26, matFrame));
    }
  });

  /* 立柱顶端收口 */
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.6, 3.6, 24), matFrame);
  crown.position.y = TOP + 1.2;
  statics.add(crown);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 16), matAccent);
  finial.position.y = TOP + 3.8;
  statics.add(finial);

  /* 灯芯外的笼子：四根细柱 + 三道箍，让中间那根光柱不至于空掉 */
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.8;
    head.add(strut(Math.cos(a) * 7.4, 20, Math.sin(a) * 7.4, Math.cos(a) * 7.4, 84, Math.sin(a) * 7.4, 0.2, matAccent));
  }
  [20, 52, 84].forEach((y) => {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(7.4, y === 52 ? 0.2 : 0.26, 10, 56), matAccent);
    hoop.rotation.x = -Math.PI / 2;
    hoop.position.y = y;
    head.add(hoop);
  });

  /* ══════════════════ 挂件 ══════════════════ */
  const charmGroup = new THREE.Group();
  head.add(charmGroup);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const cardGeo = new THREE.PlaneGeometry(CFG.card.w, CFG.card.h);

  /* 背面用的几何：把 U 反过来。因为背朝你时 UV 天然是镜像的，
     把 U 反一次正好抵消 —— 于是从灯后面看过去，卡片上的字是正的。 */
  const cardGeoBack = cardGeo.clone();
  {
    const uv = cardGeoBack.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    uv.needsUpdate = true;
  }

  /* three 的 BufferGeometryUtils 是 addon，离线包里没有；
     这里只需要位置 / 法线 / UV 三样，自己拼一下比引一整个 addon 划算。 */
  function mergeGeos(parts) {
    const list = parts.map(({ g, m }) => {
      const gg = g.clone();
      if (m) gg.applyMatrix4(m);
      return gg;
    });
    let vc = 0, ic = 0;
    for (const g of list) {
      vc += g.attributes.position.count;
      ic += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uvs = new Float32Array(vc * 2);
    const idx = new Uint32Array(ic);
    let vo = 0, io = 0;
    for (const g of list) {
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array, vo * 3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, vo * 3);
      if (g.attributes.uv) uvs.set(g.attributes.uv.array, vo * 2);
      if (g.index) {
        const gi = g.index.array;
        for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
        io += gi.length;
      } else {
        for (let k = 0; k < c; k++) idx[io + k] = vo + k;
        io += c;
      }
      vo += c;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }

  /* ── 卡片的「边」：让一块零厚度的平面片变成一块真的薄板 ────────────────
     卡片本体是 PlaneGeometry —— 正对着看没问题，一旦转起来就会缩成一条线，
     立刻暴露"这是一张纸"。真实亚克力挂件是有断面的，而且断面会**发光**：
     光从正面透进去、在板里全反射，最后从边上溢出来。
     这里按板面轮廓生成一条薄带（24 点 × 2 = 48 个顶点），
     三十六张卡共用一个几何体，成本可以忽略；
     转起来看到的那一道亮边，就是"玻璃的厚度"。 */
  function makeEdgeRibbon(t) {
    const ux = CFG.card.w / CARD_UNIT.w, uy = CFG.card.h / CARD_UNIT.h;
    const r = 26, x0 = 1.6, y0 = 1.6;
    const w = CARD_UNIT.w - 3.2, h = CARD_UNIT.h - 3.2;
    /* 画布坐标 → 卡片局部坐标。画布 y 朝下、卡片 +y 朝上，要翻一次号；
       贴图 flipY 让画布顶行落在 v=1，所以局部 y = (CARD_UNIT.h/2 − v) · uy。 */
    const pts = [];
    const push = (x, y) => pts.push([(x - CARD_UNIT.w / 2) * ux, (CARD_UNIT.h / 2 - y) * uy]);
    const arc = (cx, cy, a0, a1) => {
      for (let i = 0; i <= 5; i++) {
        const a = a0 + (a1 - a0) * (i / 5);
        push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
    };
    /* 绕板面一圈：左上 → 上 → 右 → 下 → 左（每一段都是一条圆角弧） */
    arc(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
    arc(x0 + w - r, y0 + r, Math.PI * 1.5, Math.PI * 2);
    arc(x0 + w - r, y0 + h - r, 0, Math.PI * 0.5);
    arc(x0 + r, y0 + h - r, Math.PI * 0.5, Math.PI);

    const n = pts.length;
    const pos = new Float32Array(n * 6), nor = new Float32Array(n * 6);
    const uv = new Float32Array(n * 4), idx = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      /* 外法线用切线的垂线算，比"从板心指出去"更准（圆角处差得明显） */
      const pv = pts[(i - 1 + n) % n], nx2 = pts[(i + 1) % n];
      let tx = nx2[0] - pv[0], ty = nx2[1] - pv[1];
      const tl = 1 / Math.max(1e-6, Math.hypot(tx, ty));
      const nx = -ty * tl, ny = tx * tl;
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3, uo = (i * 2 + k) * 2;
        pos[o] = pts[i][0]; pos[o + 1] = pts[i][1]; pos[o + 2] = k ? t / 2 : -t / 2;
        nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = 0;
        uv[uo] = i / n; uv[uo + 1] = k;
      }
      const a = i * 2, b = ((i + 1) % n) * 2, io = i * 6;
      idx[io] = a; idx[io + 1] = b; idx[io + 2] = a + 1;
      idx[io + 3] = b; idx[io + 4] = b + 1; idx[io + 5] = a + 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }
  /* 厚度 0.78 ≈ 卡宽的 5.3%，对应一块 3mm 厚、60mm 宽的挂件 —— 这个比例有出处 */
  const edgeGeo = makeEdgeRibbon(0.78);
  const matCardEdge = new THREE.MeshPhysicalMaterial({
    color: 0xdcecff, transparent: true, opacity: 0.46,
    roughness: 0.28, metalness: 0.0,
    sheen: 0.8, sheenRoughness: 0.4, sheenColor: new THREE.Color(0xffffff),
    envMapIntensity: 1.7, specularIntensity: 1.0,
    emissive: new THREE.Color(0xffe4c2), emissiveIntensity: 0.55,
    side: THREE.DoubleSide, depthWrite: false,
  });

  /* 卡片顶部那个孔在贴图里的位置（27 / 384）—— 金属挂环要正好穿过它。
     分母跟着 CARD_UNIT 的高度走，改比例时别忘了一起改，否则挂环会穿孔而过。 */
  const HOLE_Y_RATIO = 27 / 384;
  const ringGeo = new THREE.TorusGeometry(0.58, 0.13, 8, 20);

  const connGeo = new THREE.CylinderGeometry(0.15, 0.15, 1, 5);
  /* 刻面体。大珠用二十面体（20 面，就是那颗 d20），小珠用八面体（8 面）。
     都比球少了几十倍的面，看起来反而更贵 ——
     因为球在这么小的尺寸上只会读成一个圆点，切面才会读成"一颗宝石"。 */
  const beadBigGeo = new THREE.IcosahedronGeometry(1, 0);
  const beadSmallGeo = new THREE.OctahedronGeometry(1, 0);

  /* 吊绳改成「珠链」：一根很细的丝，沿线穿一串小刻面珠。
     上一版是一根光溜溜的圆柱（只有 6 个侧面），凑近看就是一根塑料棍 ——
     而挂件上最能体现"做得细"的地方恰恰是这根绳子。
     长度按每张卡自己的吊绳长生成（不能共享一支再按 chain 缩放：
     那样珠子会被 y 方向的拉伸扯成一颗颗竖长的茧）。 */
  function makeChainGeo(lenU) {
    const parts = [{ g: new THREE.CylinderGeometry(0.07, 0.07, lenU, 5) }];
    const n = Math.max(3, Math.min(9, Math.round(lenU / 0.55)));
    for (let i = 0; i < n; i++) {
      const y = -lenU / 2 + (i + 0.5) * (lenU / n);
      const s = 0.185 * (i % 2 ? 1.16 : 0.88);
      parts.push({
        g: beadSmallGeo,
        m: new THREE.Matrix4().compose(
          new THREE.Vector3(0, y, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35 + i * 0.9, i * 0.72, i * 0.31)),
          new THREE.Vector3(s, s * 1.45, s)
        ),
      });
    }
    return mergeGeos(parts);
  }

  /* 磨砂面的粗糙度贴图：所有卡片共用一张，不做进 resources ——
     它是这张"玻璃"本身的属性，卡片换掉也不该跟着销毁。 */
  const frostRoughTex = makeFrostRoughTexture();

  const cards = [];        // 每张卡片的动画状态
  const pickMeshes = [];   // hover 拾取用
  const resources = [];    // 需要 dispose 的贴图 / 材质
  const geoExtras = [];    // 按卡片各自生成的几何体（珠链长度不同，无法共享）
  const rnd = rngFrom(20260916);

  /* 一个环上排布若干挂点；吊绳长度随机，才会有一层层叠出来的体积感 */
  function slotsOf(ring) {
    const out = [];
    for (let i = 0; i < ring.count; i++) {
      out.push({
        angle: (i / ring.count) * TAU + ring.y * 0.017,
        radius: ring.r + (rnd() - 0.5) * 2 * ring.jitter,
        y: ring.y,
        chain: lerp(ring.chainMin, ring.chainMax, Math.pow(rnd(), 0.85)),
        /* 尺寸抖动收窄到 ±4%：叶子差得太多，同层相邻就会有卡片擦到一起 */
        scale: ring.scale * (0.96 + rnd() * 0.08),
        seed: Math.floor(rnd() * 1e6),
        omega: 2.05 + rnd() * 0.95,
        zeta: 0.05 + rnd() * 0.055,
        phase: rnd(),
      });
    }
    return out;
  }

  function clearCards() {
    for (const r of resources) { r.tex.dispose(); r.mat.dispose(); r.matBack.dispose(); }
    resources.length = 0;
    for (const g of geoExtras) g.dispose();
    geoExtras.length = 0;
    cards.length = 0;
    pickMeshes.length = 0;
    charmGroup.clear();
  }

  function buildCards() {
    clearCards();
    const defs = Array.isArray(opt.cards) && opt.cards.length ? opt.cards : DEFAULT_CARDS;
    let n = 0;

    CFG.rings.forEach((ring) => {
      for (const spec of slotsOf(ring)) {
        const def = defs[n % defs.length];
        def.__seed = spec.seed;
        n++;

        /* 悬挂点 → 钟摆的支点。yaw 负责朝向，swing 负责摆动 */
        const yaw = new THREE.Group();
        yaw.position.set(Math.cos(spec.angle) * spec.radius, spec.y, Math.sin(spec.angle) * spec.radius);
        /* 朝向带上 ±6° 的随机偏移。整整齐齐朝一个方向时，一圈卡片会连成一道"栅栏"，
           侧面看只剩一条白边；各自歪一点，光落在每张上的角度就不同，
           眼睛能一张一张地读，而不是读成一圈墙。
           幅度压在 6° 以内 —— 再大，同层相邻两张的角会互相蹭到。
           用 seed 派生而不是再抽一次随机数：同一个 seed 永远摆出同一个样子。 */
        const wobble = ((spec.seed % 997) / 997 - 0.5) * 0.21;
        yaw.rotation.y = Math.PI / 2 - spec.angle + wobble;
        const swing = new THREE.Group();
        yaw.add(swing);
        charmGroup.add(yaw);

        /* 吊绳（珠链）：几何按本张卡的真实长度生成，再整体按卡片尺寸缩放。
           上一版只缩 y、不缩 x/z —— 最小那层（0.62）会挂着一根和最大卡
           一样粗的绳子。 */
        const chainGeoThis = makeChainGeo(spec.chain / spec.scale);
        const chain = new THREE.Mesh(chainGeoThis, matWire);
        chain.position.y = -spec.chain / 2;
        chain.scale.setScalar(spec.scale);
        swing.add(chain);
        geoExtras.push(chainGeoThis);

        /* 卡片本体。正反两面各一片、共面、朝向互为相反：
             正面片 FrontSide + 背面片 BackSide，同一个贴图对象，背面片的 UV 反过来。
             这样绕到灯后面看，字是正的；而两片又永远不会同时可见 ——
             既没有镜像字，也不会有半透明的重影。 */
        const tex = new THREE.CanvasTexture(paintCard(def, spec.seed, def._ready));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = maxAniso;
        /* 磨砂玻璃材质。和抛光版的差别集中在四处，少一处就退回"塑料片"：
             · roughness 0.18 → 0.46，并且挂上 roughnessMap：高光从"一条硬亮线"
               变成"一片有起伏的柔光"，这是磨砂最核心的一条；
             · clearcoatRoughness 0.08 → 0.36：上面那层釉也磨砂了。
               清漆保持镜面的话，底下的磨砂会被它盖住；
             · sheen / sheenRoughness / sheenColor：擦边角度的一层柔绒反光。
               这是 three.js 里唯一专为"磨砂散射"准备的项，不用它等于白做；
             · 贴图本身也换了（见 paintCard）：奶白半透 + 边缘聚光 + 喷砂颗粒。 */
        const mat = new THREE.MeshPhysicalMaterial({
          map: tex,
          roughnessMap: frostRoughTex,
          transparent: true,
          side: THREE.FrontSide,
          roughness: 0.46,
          metalness: 0.0,
          clearcoat: 0.62,
          clearcoatRoughness: 0.36,
          sheen: 1.0,
          sheenRoughness: 0.62,
          sheenColor: new THREE.Color(0xffe3c0),
          envMapIntensity: 1.15,     // 反射够用就行；拉太高整张卡会被环境洗白
          specularIntensity: 0.72,
          emissive: new THREE.Color(0xfff3e8),
          emissiveMap: tex,
          /* ★ 2026-10-06 空卡灯牌化：0.19 是给"有画面的卡"配的 —— 画面自身
             有色彩浓度，内透只需点到为止。空卡整张都是浅色留白，ACES 会把
             浅色压灰（实测截图），灯牌的"光从里面漫出来"必须靠这档补：
             0.19 → 0.42，卡片自己成为光源的一部分。
             发光色也从暖橙 0xffd7a0 转中性微暖 0xfff3e8 —— 实测第二轮：
             暖橙在这个强度会把五张浅色卡全染成奶油色，色相全被吃掉。 */
          emissiveIntensity: 0.42,
        });
        const matBack = mat.clone();
        matBack.side = THREE.BackSide;
        resources.push({ tex, mat, matBack });

        const cardH = CFG.card.h * spec.scale;
        const baseY = -spec.chain - cardH / 2;
        const mesh = new THREE.Mesh(cardGeo, mat);
        mesh.position.y = baseY;
        mesh.scale.setScalar(spec.scale);
        /* 断面薄带挂在卡片自己身上（当子物体）而不是并列 ——
           hover 时卡片会被抬起来 1.1 个单位的位移，并列的话
           边和面会分开，露出一道缝。挂成子物体就永远严丝合缝。 */
        mesh.add(new THREE.Mesh(edgeGeo, matCardEdge));
        swing.add(mesh);

        const meshBack = new THREE.Mesh(cardGeoBack, matBack);
        meshBack.position.y = baseY;
        meshBack.scale.setScalar(spec.scale);
        swing.add(meshBack);

        /* 穿过卡上那个孔的小金属环 —— 挂件之所以像"真的被挂起来"，
           八成靠这一颗环：有它，吊绳才不是在卡片顶上凭空断掉。 */
        const ring = new THREE.Mesh(ringGeo, matAccent);
        ring.position.y = -spec.chain - CFG.card.h * HOLE_Y_RATIO * spec.scale;
        ring.rotation.y = Math.PI / 2;      // 环面垂直于卡片，才是"穿过去"的样子
        ring.scale.setScalar(spec.scale);
        swing.add(ring);

        /* 卡孔垫珠：吊绳末端压在孔上的那一颗小钢珠。
           少了它，吊绳就是"扎进玻璃里"的 —— 有了它，力才有个落点。
           位置压在挂环正上方半个珠径处，看起来是绳索穿过珠子再穿进孔。 */
        const beadHole = new THREE.Mesh(beadSmallGeo, matBeadSteel);
        beadHole.scale.setScalar(0.30 * spec.scale);
        beadHole.position.y = ring.position.y + 0.62 * spec.scale;
        beadHole.rotation.y = 0.4;          // 八面体转一点，别让棱对着正前方
        swing.add(beadHole);

        /* 卡片下面坠的珠子：连接杆穿过两颗珠子 */
        const bottom = -spec.chain - cardH;
        const bigR = 1.28 * spec.scale;
        const bigY = bottom - bigR * 2.3;
        const conn = new THREE.Mesh(connGeo, matWire);
        conn.position.y = (bottom + bigY) / 2;
        conn.scale.y = bottom - bigY;
        swing.add(conn);

        const beadBig = new THREE.Mesh(beadBigGeo, matBeads[Math.floor(rnd() * matBeads.length)]);
        beadBig.scale.setScalar(bigR);
        beadBig.position.y = bigY;
        swing.add(beadBig);

        const beadSmall = new THREE.Mesh(beadSmallGeo, matBeadSteel);
        beadSmall.scale.setScalar(0.54 * spec.scale);
        beadSmall.position.y = bottom - 0.9 * spec.scale;
        swing.add(beadSmall);

        /* 再坠一颗更小的刻面坠。三颗由大到小一路收下去，垂坠才"收得住"——
           两颗就停了，看起来像是断在那儿了。 */
        const beadTip = new THREE.Mesh(beadBigGeo, matBeads[Math.floor(rnd() * matBeads.length)]);
        beadTip.scale.setScalar(bigR * 0.5);
        beadTip.position.y = beadSmall.position.y - 0.74 * spec.scale;
        beadTip.rotation.y = 0.3;
        swing.add(beadTip);

        const rec = {
          spec, def, yaw, swing, mesh, meshBack, mat, matBack, tex, baseY,
          angle: 0, av: 0, hover: 0, hoverT: 0,
        };
        mesh.userData.rec = rec;
        meshBack.userData.rec = rec;
        cards.push(rec);
        /* 正反两片都要登记。只登记正面片的话，卡片转到背面朝你时，
           那一面被背面剔除、射线打不中 —— 你会看到一张卡，hover 没有手型，
           点下去没反应。这不是"次要的拾取细节"，是三分之一的时间点不动它。 */
        pickMeshes.push(mesh, meshBack);

        /* 如果这张卡指定了图片，异步加载完再重画一次贴图 —— 不阻塞首屏 */
        if (def.image) resolveImage(def, tex);
      }
    });
  }

  /* def.image 支持：图片 URL / HTMLImageElement / HTMLCanvasElement / ImageBitmap */
  function resolveImage(def, tex) {
    const src = def.image;
    const apply = (drawable) => {
      tex.image = paintCard(def, def.__seed, drawable);
      tex.needsUpdate = true;
    };
    if (typeof src === 'string') {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => apply(im);
      im.src = src;
      return;
    }
    if (src instanceof HTMLCanvasElement || src instanceof HTMLImageElement ||
        (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap)) {
      apply(src);
    }
  }

  buildCards();

  /* ══════════════════ 空气里的浮尘 ══════════════════ */
  let dust = null;
  if (opt.dust) {
    const N = 110;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = rnd() * TAU, r = 20 + rnd() * 68;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = -6 + rnd() * 132;
      pos[i * 3 + 2] = Math.sin(a) * r;
      vel[i] = 0.9 + rnd() * 2.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dust = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffd9a2, size: 0.85, sizeAttenuation: true, transparent: true,
      opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    dust.frustumCulled = false;
    dust.userData = { pos, vel, N };
    scene.add(dust);
  }

  /* ══════════════════ 点击放大 ══════════════════
     做法：不动相机（相机会和自转、拖拽打架），而是把被点中的那张卡
     单独"提"出来 —— 从它挂在环上的原位，飞到相机正前方放大展开。
     原位那一个同时隐藏，观感就是"从灯上取下来拿到眼前看"。
     飞行途中位置、朝向、大小一起插值，所以是一气呵成的，不是切换。 */
  const FOCUS = { dur: 0.55, dist: 150, hFill: 0.64, wFill: 0.74, tiltX: -0.055, tiltY: 0.13 };

  /* 放大态的手势参数。拖 = 把它拿在手里转一圈，只点一下（没挪动）= 放回灯上。
     上一版是"按下即收起"，于是卡片一旦被举起来就什么都做不了 ——
     一张彻底静止的卡看着就是一张贴图，而且玻璃的高光会永远钉在同一个位置，
     转起来那道光才会扫过卡面，"举着一块玻璃"这件事才成立。

     转动范围要给足：±35° 只是"歪了一点"，看不出是个立体的片子；
     给到 ±55° 才真的能看到断面从侧面转出来 —— 那正是"飞起来"的手感来源。 */
  const SPIN = { maxY: 0.96, maxX: 0.46, k: 0.0055, back: 3.6 };
  const spinE = new THREE.Euler(), spinQ = new THREE.Quaternion(), spinInv = new THREE.Quaternion();

  const focusGroup = new THREE.Group();
  focusGroup.visible = false;
  scene.add(focusGroup);

  /* 放大态单独一张高分辨率贴图：同步重画（几毫秒），藏在起飞动画里谁都察觉不到 */
  const focusCanvas = document.createElement('canvas');
  focusCanvas.width = CARD_TEX.w * CARD_TEX_HI;
  focusCanvas.height = CARD_TEX.h * CARD_TEX_HI;
  const focusTex = new THREE.CanvasTexture(focusCanvas);
  focusTex.colorSpace = THREE.SRGBColorSpace;
  focusTex.anisotropy = maxAniso;

  const focusMat = new THREE.MeshPhysicalMaterial({
    map: focusTex, transparent: true, side: THREE.DoubleSide,
    /* depthTest 关掉 + renderOrder 拉满 —— 这两条缺一不可。
       灯近侧的卡片离相机比它更近，透明物体是按距离从远到近画的，
       不这么做，被点起来的这张会被灯挡在背后。 */
    depthTest: false, depthWrite: false,
    /* 这里刻意不开 clearcoat：正面那盏阅读灯会在镜面高光上烧出一个亮斑，
       正好落在卡面正中，很脏。磨砂的反光感交给 roughnessMap 和 sheen。
       板面改成半透之后，材质这一层要接过"玻璃"的活：
       sheen 拉高（擦边的那圈柔光）、envMapIntensity 抬高（环境要在板面上留得下来）。 */
    roughness: 0.40, roughnessMap: frostRoughTex, metalness: 0.0,
    sheen: 0.95, sheenRoughness: 0.50, sheenColor: new THREE.Color(0xffe3c0),
    specularIntensity: 0.68, envMapIntensity: 1.35,
    emissive: new THREE.Color(0xffd7a0), emissiveMap: focusTex, emissiveIntensity: 0.11,
  });
  const focusMesh = new THREE.Mesh(new THREE.PlaneGeometry(CFG.card.w, CFG.card.h), focusMat);
  focusMesh.renderOrder = 9999;
  focusMesh.frustumCulled = false;
  focusGroup.add(focusMesh);

  /* 放大态的断面：和缩小态共用同一支几何，但这里必须"看得见"。
     排在暗场和投影之上、卡片之下 —— 卡片转到侧面时会看到一道发光的玻璃边
     从卡片边缘透出来，这正是亚克力最贵的那个特征（内部全反射）。
     颜色每次打开时按这张卡自己的色相调，所以转起来那道边是跟着卡走的。 */
  const edgeMatFocus = new THREE.MeshPhysicalMaterial({
    color: 0xdcecff, transparent: true, opacity: 0.74,
    roughness: 0.22, metalness: 0.0,
    sheen: 0.9, sheenRoughness: 0.36, sheenColor: new THREE.Color(0xffffff),
    envMapIntensity: 2.0, specularIntensity: 1.0,
    emissive: new THREE.Color(0xffd9a8), emissiveIntensity: 0.85,
    side: THREE.DoubleSide,
    depthTest: false, depthWrite: false,
  });
  const focusEdge = new THREE.Mesh(edgeGeo, edgeMatFocus);
  focusEdge.renderOrder = 9993;
  focusEdge.frustumCulled = false;
  focusGroup.add(focusEdge);

  /* 卡片背后那团投影。挂在 focusGroup 上，所以它跟着卡片一起飞、一起转，
     看起来就是"这张卡自己的影子"。
     注意：大小和偏移都要在 stepFocus 里跟着卡片的世界缩放一起变 ——
     片子的 geometry 只有 1.5 张卡大，而卡片落定时会涨到五六倍，
     不跟着放，影子会被卡片整张盖住，等于没画。 */
  const shadowTex = makeSoftShadowTexture();
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const focusShadow = new THREE.Mesh(new THREE.PlaneGeometry(CFG.card.w * 1.5, CFG.card.h * 1.5), shadowMat);
  focusShadow.renderOrder = 9992;
  focusShadow.frustumCulled = false;
  focusGroup.add(focusShadow);

  /* 卡片背后漏出来的那圈暖光。背景是暗的，纯黑的投影在暗底上几乎读不出来；
     真正让"它被举起来了"成立的，是卡片挡住了身后那盏灯、四周漏出来的光。
     用加色混合，排在投影底下（renderOrder 更小），投影再压上去，
     就有了"挡光"的层次 —— 这是放大态里最省的一条立体线索。 */
  const haloMat = new THREE.SpriteMaterial({
    map: makeGlowTexture(0.40, 0.15, '255,199,138'),
    blending: THREE.AdditiveBlending, transparent: true,
    depthTest: false, depthWrite: false, opacity: 0, toneMapped: false,
  });
  const focusHalo = new THREE.Sprite(haloMat);
  focusHalo.renderOrder = 9991;
  focusGroup.add(focusHalo);

  let focus = null;   /* { rec, t, closing, fromPos/Quat/Scale, toPos/Quat/Scale,
                          spin, spinY, spinX, vY, vX } —— 后五个是"拿在手里转"的状态 */

  /* 提示文字：这个用 DOM 就够了，它在画布之上，不需要和 3D 排序 */
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
  const tipEl = document.createElement('div');
  /* 做成一颗小胶囊。原来只是一行悬空的字，暗场里它正好压在底座和地面光斑上，
     亮的地方字看不清、暗的地方又像脏点。给一层半透明底 + 细描边 + 背景模糊，
     它就有了自己的"面"，压在任何背景上都读得出来。 */
  tipEl.style.cssText =
    'position:absolute;left:50%;bottom:46px;transform:translateX(-50%);white-space:nowrap;' +
    'padding:9px 18px 8px;border-radius:999px;' +
    'background:rgba(12,9,14,.46);border:1px solid rgba(255,236,206,.16);' +
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);' +
    'font:500 12.5px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
    'letter-spacing:.16em;color:rgba(250,240,226,.88);opacity:0;transition:opacity .5s ease .28s;';
  tipEl.textContent = '按住拖一拖可以转 · 点一下放回灯上';
  layer.appendChild(tipEl);
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(layer);

  /* 暗场：挂在相机上的一块面片，尺寸永远刚好盖住视锥。
     用 3D 面片而不是 DOM 层，是为了让它只压背景 —— 卡片 renderOrder 更高，画在它上面。 */
  const dimTex = makeDimTexture();
  const dimMat = new THREE.MeshBasicMaterial({
    map: dimTex, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const dimMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dimMat);
  dimMesh.position.z = -1;
  /* 9990：排在暖光（9991）和投影（9992）之前，
     否则暗场会把这两样再压一层，卡片背后就没有层次了 */
  dimMesh.renderOrder = 9990;
  dimMesh.frustumCulled = false;
  camera.add(dimMesh);
  scene.add(camera);        // 相机的子物体要参与渲染，相机本身得在场景里

  /* 一盏"阅读灯"跟着被拿起来的卡片走。
     卡片移到相机前方后就离开了灯芯的照度范围（点光按 1/d² 衰减），不补光整张会发灰。
     distance 卡在 70：只够照到眼前这张卡，照不到背后那盏灯 ——
     否则整盏灯会被这盏补光"拍平"，失去原来的明暗层次。 */
  const readLight = new THREE.PointLight(0xfff3e0, 900, 70, 2);
  readLight.position.set(0, 0, 34);   // 卡片正面 34 单位处
  focusGroup.add(readLight);

  function sizeDim() {
    const vf = Math.tan((camera.fov * Math.PI) / 360);
    dimMesh.scale.set(2 * vf * camera.aspect * 1.06, 2 * vf * 1.06, 1);
  }

  const easeOut = (x) => 1 - Math.pow(1 - x, 3);

  /* 相机前方那个落点：高度占屏 hFill、宽度留 wFill 的余量，取二者中更小的比例 */
  function focusTarget() {
    const d = FOCUS.dist;
    const vf = Math.tan((camera.fov * Math.PI) / 360);
    const fitH = 2 * vf * d * FOCUS.hFill;
    const fitW = 2 * vf * d * camera.aspect * FOCUS.wFill;
    const scale = Math.min(fitH / CFG.card.h, fitW / CFG.card.w);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const pos = camera.position.clone().addScaledVector(fwd, d);
    /* 不用完全正对：微微侧一点、仰一点，像拿在手里看，比死正面耐看得多 */
    const quat = camera.quaternion.clone().multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(FOCUS.tiltX, FOCUS.tiltY, 0.012, 'YXZ'))
    );
    return { pos, quat, scale };
  }

  /* 放大态那张贴图的"预画"。
     第一次点开之所以会卡一下（实测 ~90ms 一帧），不是因为画得慢 ——
     canvas 的绘制指令是延后栅格化的，真正掏钱的是"栅格化 + 3.5MB 贴图上传"
     这两件事，而它们都落在动画的第一帧上。
     所以：鼠标在卡片上停住超过一点点时间（说明多半是要点它了），
     就趁这个空档把贴图先画好、先传上去。等真点下去时，贴图已经是现成的。
     停留阈值是刻意的 —— 鼠标扫过一排卡时不画，只有"停下来了"才画，
     不然划过三十六张卡会一路卡顿。 */
  let dwellRec = null, dwellT = 0, preparedRec = null;
  function prepareFocusTex(rec) {
    focusTex.image = paintCard(rec.def, rec.spec.seed, rec.def._ready, true);
    focusTex.needsUpdate = true;
    /* 主循环此刻不会画 focusGroup，贴图不会被顺带上传，得手动推一把 */
    if (renderer.initTexture) renderer.initTexture(focusTex);
    preparedRec = rec;
  }

  function openFocus(rec) {
    if (!rec) return;

    /* 1) 现画一张高分辨率贴图（放大态专用，不回写卡片本身）。
          如果刚才悬停时已经预画过这张卡，这一步就整个省掉 —— 点击到起飞之间
          不再有任何要现算的东西。 */
    if (preparedRec !== rec) {
      focusTex.image = paintCard(rec.def, rec.spec.seed, rec.def._ready, true);
      focusTex.needsUpdate = true;
    }

    /* 2) 记下"从哪来" */
    const fromPos = new THREE.Vector3();
    const fromQuat = new THREE.Quaternion();
    const fromScale = new THREE.Vector3();
    rec.mesh.updateWorldMatrix(true, false);
    rec.mesh.getWorldPosition(fromPos);
    rec.mesh.getWorldQuaternion(fromQuat);
    rec.mesh.getWorldScale(fromScale);

    const to = focusTarget();
    focus = {
      rec, t: 0, closing: false,
      fromPos, fromQuat, fromScale: fromScale.x,
      toPos: to.pos, toQuat: to.quat, toScale: to.scale,
      spin: false, spinY: 0, spinX: 0, vY: 0, vX: 0,
    };

    /* 断面按这张卡自己的色相调。真实亚克力的断面不是白的 ——
       它是被射进去的印刷色照亮的，所以那道边一定带一点卡片自己的颜色。
       少了这一步，转起来时卡是绿的、边是白的，一眼就穿帮。 */
    const pal = PALETTE[rec.def.tone] || PALETTE.cream;
    edgeMatFocus.color.set(pal.fill).lerp(new THREE.Color(0xffffff), 0.58);
    edgeMatFocus.emissive.set(pal.fill).lerp(new THREE.Color(0xffe0b0), 0.42);

    focusMesh.scale.setScalar(focus.fromScale);
    focusGroup.position.copy(fromPos);
    focusGroup.quaternion.copy(fromQuat);
    focusGroup.visible = true;

    rec.yaw.visible = false;          // 原位那一个藏起来，否则会看到两张
    tipEl.style.opacity = '1';
    canvas.style.cursor = 'zoom-out';
    if (typeof api.onFocus === 'function') api.onFocus(rec);
  }

  function closeFocus() {
    if (!focus || focus.closing) return;
    focus.closing = true;
    tipEl.style.opacity = '0';
    canvas.style.cursor = 'grab';
  }

  function endFocus() {
    if (focus && focus.rec) focus.rec.yaw.visible = true;
    focus = null;
    focusGroup.visible = false;
    dimMat.opacity = 0;
    if (typeof api.onBlur === 'function') api.onBlur();
  }

  /* 窗口尺寸变了、相机参数不一样了，落点得重算一次 */
  function refitFocus() {
    if (!focus) return;
    const to = focusTarget();
    focus.toPos = to.pos;
    focus.toQuat = to.quat;
    focus.toScale = to.scale;
  }

  function stepFocus(dt) {
    /* 暗场自己淡入淡出，比 CSS 过渡更好控：它能和卡片严丝合缝地对上时间 */
    const dimTarget = focus && !focus.closing ? 1 : 0;
    dimMat.opacity += (dimTarget - dimMat.opacity) * Math.min(1, dt * 6.5);
    dimMesh.visible = dimMat.opacity > 0.004;   // 淡到看不见就别再画了
    /* 投影跟着暗场一起淡 —— 亮着灯的原地不该有影子，暗下来之后才该有 */
    shadowMat.opacity = 0.72 * dimMat.opacity;
    haloMat.opacity = 0.40 * dimMat.opacity;
    focusShadow.visible = focusHalo.visible = dimMat.opacity > 0.02;
    if (!focus) return;
    focus.t = clamp(focus.t + (focus.closing ? -1 : 1) * (dt / FOCUS.dur), 0, 1);
    const e = easeOut(focus.t);
    focusGroup.position.lerpVectors(focus.fromPos, focus.toPos, e);
    focusGroup.quaternion.copy(focus.fromQuat).slerp(focus.toQuat, e);

    /* 转动：手指按着就直接跟随；松开之后先按惯性滑一段，再被轻轻拉回正对。
       直接线性回中会像被弹簧弹回来，太机械 —— 惯性 + 很轻的回正是"手感"。 */
    if (!focus.spin) {
      focus.spinY = clamp(focus.spinY + focus.vY * dt, -SPIN.maxY * 1.3, SPIN.maxY * 1.3);
      focus.spinX = clamp(focus.spinX + focus.vX * dt, -SPIN.maxX * 1.3, SPIN.maxX * 1.3);
      const k = Math.min(1, SPIN.back * dt);
      focus.spinY -= focus.spinY * k;
      focus.spinX -= focus.spinX * k;
      const damp = Math.pow(0.015, dt);
      focus.vY *= damp;
      focus.vX *= damp;
      if (Math.abs(focus.spinY) < 1e-4) focus.spinY = 0;
      if (Math.abs(focus.spinX) < 1e-4) focus.spinX = 0;
      if (Math.abs(focus.vY) < 1e-4) focus.vY = 0;
      if (Math.abs(focus.vX) < 1e-4) focus.vX = 0;
    }
    /* 乘在右边 = 绕卡片自己的轴转：基础姿态回答"这张卡怎么摆"，
       转动回答"我把它转到哪儿"，两者互不干扰。 */
    spinQ.setFromEuler(spinE.set(focus.spinX, focus.spinY, 0, 'YXZ'));
    focusGroup.quaternion.multiply(spinQ);

    focusMesh.scale.setScalar(focus.fromScale + (focus.toScale - focus.fromScale) * e);
    /* 影子、暖光、断面都得按卡片当前的世界缩放重新摆一遍：
       卡片是从挂在环上的小尺寸一路涨到眼前的，它们的基准尺寸只有一张卡那么大。 */
    const cs = focusMesh.scale.x;
    focusShadow.scale.setScalar(cs);
    focusShadow.position.set(CFG.card.w * 0.075 * cs, -CFG.card.h * 0.08 * cs, -3);
    focusHalo.scale.set(CFG.card.w * 2.35 * cs, CFG.card.h * 1.6 * cs, 1);
    focusEdge.scale.setScalar(cs);
    /* 影子是"贴在镜头前"的一层，不能跟着卡片一起转 ——
       转了就变成一片跟着倾斜的污渍。反着转回来，永远正对相机。 */
    focusShadow.quaternion.copy(spinInv.copy(spinQ).invert());
    /* 落定之后极轻地"呼吸"一下。一张完全静止的卡看着像贴图；
       半度不到的位移 + 1% 出头的大小变化，才像被捏在手里端详。
       只在 t 过了 0.68 之后才给，收起时 t 往回走，它自己就没了。 */
    const settle = clamp((focus.t - 0.68) / 0.32, 0, 1);
    if (settle > 0) {
      focusMesh.scale.multiplyScalar(1 + Math.sin(time * 1.45) * 0.011 * settle);
      focusGroup.position.y += Math.sin(time * 1.45 + 0.6) * 0.42 * settle;
    }
    if (focus.closing && focus.t <= 0) endFocus();
  }

  /* ══════════════════ 交互：自己写的轨道控制器，省掉一个依赖 ══════════════════ */
  const canvas = renderer.domElement;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let theta = CFG.cam.theta, phi = CFG.cam.phi;
  let thetaT = theta, phiT = phi;
  let dist = CFG.cam.dist, distT = CFG.cam.dist;
  let minDist = 96, maxDist = 360, fitted = false;
  let windBurst = 0;
  let dragging = false, lastX = 0, lastY = 0;
  /* pressed 和 dragging 要分开记：pointerleave 会把 dragging 清掉，
     但"手指已经按下"这件事不该因此丢失 —— 否则在按下与抬起之间指针只要
     擦出过画布，这一次点击就被吞掉了。 */
  let pressed = false;
  let pointerInside = false;
  /* ── 触摸屏 ────────────────────────────────────────────────────────────
     手机没有滚轮、也没有 hover，两件事得单独照顾：
       · 缩放只剩双指一条路，所以必须同时跟踪多根手指（ptrs 按 pointerId 存）。
       · 触摸设备上"悬停高亮"和鼠标手型是没有意义的，而且手指离开画面后
         最后那次拾取会一直亮着，所以触摸模式下干脆关掉。
     但真正的命门不在这里，在 CSS 的 touch-action: none —— 那条不写，
     浏览器中途会把手指"抢"去滚页面。 */
  const ptrs = new Map();
  let pinching = false, pinchD = 0;
  let touchMode = false;
  let downX = 0, downY = 0, downAt = 0, travel = 0;
  /* 判"这是一次点击"用两个阈值。距离是主判据 —— 手指/鼠标有没有挪过地方；
     时间只用来挡"按住很久再松手"，所以要给得宽松。
     之前定的 450ms 太紧：手慢一点的人、或者触控板上按得犹豫一点，这一次点击就被吞了。 */
  const CLICK_MAX_TRAVEL = 8;    // px
  const CLICK_MAX_MS = 1200;     // ms
  /* 拖动转视角的手感参数。
     k 是"一个像素转多少弧度"：1440 宽的屏横拖满约 290°，滑动一次差不多转大半圈，
     再多就晕、再少就觉得"拖不动"。手机上单次滑动只有 390px，约 85°，也够用。
     phi 是俯仰角（0 = 正上方俯视，π/2 = 平视，>π/2 = 钻到灯下面）。
     上下都要留边界：抬太高四层环会压成一叠（CFG 里注释过这件事），
     压太低相机会钻到地面以下，看见的就不是这盏灯了。 */
  const ORBIT = { k: 0.0038, phiMin: 0.72, phiMax: 1.74, floorY: 6 };

  /* 俯仰的实际上界随距离变。相机高度是 camTargetY + dist*cos(phi)：
     固定一个上界的话，在最大距离上同样的角度会把相机压到地面以下 ——
     那时看到的就不是这盏灯了。所以拉远的时候要把它收紧。
     用 distT（目标距离）而不是 dist：阻尼中的 dist 慢半拍，那一帧就够钻下去了。 */
  function orbitPhiMax(d) {
    const c = (ORBIT.floorY - camTargetY) / Math.max(1, d);
    return Math.min(ORBIT.phiMax, Math.acos(clamp(c, -0.92, 0.92)));
  }
  const pointer = new THREE.Vector2(-10, -10);
  const raycaster = new THREE.Raycaster();

  function setPointer(e) {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    pointer.set((e.clientX / w) * 2 - 1, -((e.clientY / h) * 2 - 1));
  }

  /* 两指之间的屏幕距离。缩放就是看这个值怎么变。 */
  function twoDist() {
    const it = ptrs.values();
    const a = it.next().value, b = it.next().value;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onDown(e) {
    if (e.pointerType === 'touch') touchMode = true;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    /* 第二根手指一落下，"缩放"就接管了这一次手势：它不再是点击，也不是转动。
       把 pressed / dragging 一起清掉，后面交给 onMove 的缩放分支。 */
    if (ptrs.size === 2) {
      pinching = true;
      pinchD = twoDist();
      pressed = false;
      dragging = false;
      canvas.classList.remove('dragging');
      if (focus) focus.spin = false;
      try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (pinching) return;          /* 第三根手指起，不再理会 */
    /* 放大态下"按下"不再立刻收起 —— 那会让卡片举起来之后什么都做不了。
       现在按下进入"转它"，是不是点击（没挪动）留到 onUp 判，和缩小态共用一套判据。 */
    pressed = true;
    dragging = true;
    downX = e.clientX; downY = e.clientY;
    downAt = performance.now(); travel = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    /* 触摸设备不做悬停拾取 —— 手指落下的位置不该留下一次"高亮"。
       点击时 onUp 会自己重新 setPointer 再拾取，所以这里跳过不影响点卡。 */
    if (e.pointerType !== 'touch') {
      setPointer(e);
      pointerInside = true;
    }
    canvas.classList.add('dragging');
    if (focus && !focus.closing) {
      focus.spin = true;
      focus.vY = focus.vX = 0;
      if (!touchMode) canvas.style.cursor = 'grabbing';
    }
    /* 要 try：指针在调用前就已经释放时这里会抛 NotFoundError，不该让它冒出去 */
    try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function onMove(e) {
    /* 触摸时不做悬停拾取：手指离开后最后一次拾取会一直亮着，
       而且 hover 高亮本来就是给鼠标看的，手指感受不到。 */
    if (e.pointerType !== 'touch') {
      setPointer(e);
      pointerInside = true;
    }
    const p = ptrs.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    /* 双指缩放。这段必须放在 !dragging 之前 —— 进双指时我们已经把
       dragging 清掉了，不提前处理就会被下面那行 return 吃掉。 */
    if (pinching) {
      if (ptrs.size >= 2) {
        const d = twoDist();
        /* 手指拉开 = 拉近。取比值而不是差值，缩放快慢就跟当前远近无关，
           手感是匀的（差值在拉远之后会变得几乎没有反应）。 */
        if (pinchD > 4 && d > 4) distT = clamp(distT * (pinchD / d), minDist, maxDist);
        pinchD = d;
      }
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    travel = Math.max(travel, Math.hypot(e.clientX - downX, e.clientY - downY));
    if (focus) {
      /* 放大态：拖动 = 把这张卡转一转。转角夹在两个上限里 ——
         卡片是零厚度的平面片，转过 35° 就会开始露馅；
         而在这个范围内，正好够让玻璃的高光扫过卡面。 */
      focus.spinY = clamp(focus.spinY + dx * SPIN.k, -SPIN.maxY, SPIN.maxY);
      focus.spinX = clamp(focus.spinX + dy * SPIN.k, -SPIN.maxX, SPIN.maxX);
      focus.vY = clamp(dx * SPIN.k * 16, -2.4, 2.4);
      focus.vX = clamp(dy * SPIN.k * 16, -1.8, 1.8);
      return;
    }
    /* ── 拖动 = 转着看这盏灯 ────────────────────────────────────────────
       这里原本只吹风、不转视角：thetaT / phiT 声明了，tick 里也一直给它们
       做阻尼，但没有任何一处给它们赋过值 —— 于是"拖动旋转"那句提示是空的，
       按住拖动只会让卡片晃一下，视角一动不动。
       方向跟主流轨道控制一致：右拖 = 相机向左绕（物体像被拨向右边），
       下拖 = 相机升高（像把物体往下按，露出顶面）。 */
    thetaT -= dx * ORBIT.k;
    phiT = clamp(phiT - dy * ORBIT.k, ORBIT.phiMin, ORBIT.phiMax);
    // 你转得越快，带起来的风越大 —— 这就是"吹风"的手势版
    windBurst = Math.min(2.8, windBurst + Math.hypot(dx, dy) * 0.045);
  }
  function onUp(e) {
    ptrs.delete(e.pointerId);
    if (pinching) {
      /* 抬到只剩一根手指时结束缩放。留在屏幕上的那根不接管 ——
         刚捏完紧接着就转，几乎都是误操作。 */
      if (ptrs.size < 2) { pinching = false; pinchD = 0; }
      pressed = false;
      dragging = false;
      canvas.classList.remove('dragging');
      if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }
      return;
    }
    const wasPressed = pressed;
    pressed = false;
    dragging = false;
    canvas.classList.remove('dragging');
    if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }
    if (!wasPressed) return;
    /* 位移够小、时间够短 —— 才算一次"点击"。否则每次拖动都会误触发放大。 */
    const isClick = travel < CLICK_MAX_TRAVEL && performance.now() - downAt < CLICK_MAX_MS;
    if (focus) {
      focus.spin = false;              // 松手：交给惯性
      if (isClick) closeFocus();       // 但确实只是点了一下 → 放回灯上
      else if (!touchMode) canvas.style.cursor = 'zoom-out';
      return;
    }
    if (isClick) {
      setPointer(e);
      pickCard();
    }
  }
  function pickCard() {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickMeshes, false);
    if (!hits.length) return;
    const rec = hits[0].object.userData.rec;
    if (rec) openFocus(rec);
  }
  function onWheel(e) {
    e.preventDefault();
    if (focus) { closeFocus(); return; }   // 放大态下滚轮 = 收起来
    distT = clamp(distT * (1 + e.deltaY * 0.0012), minDist, maxDist);
  }
  function onLeave() {
    dragging = false;
    pointerInside = false;
    pointer.set(-10, -10);
    canvas.classList.remove('dragging');
    /* 指针擦出画布也要松开"正在转"，否则卡片会一直攥着不动 */
    if (focus) focus.spin = false;
    /* 触摸时 pointerleave 往往等不到 up 就先来了。这里不把手记清掉的话，
       下一次单指落下会被当成"双指的第二次"，整块画布就此失去响应。 */
    if (touchMode && !pinching) ptrs.clear();
  }
  function onKey(e) {
    if (e.key === 'Escape' && focus) closeFocus();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  /* 兜底：指针在画布外松手时 up 收不到（setPointerCapture 未必拿得到，
     自动化派发的事件就拿不到），这一次点击会白按。挂在 window 上补一层。
     onUp 自己幂等 —— 第一次已经把它处理掉了，重复进来会因为 pressed 已清而直接返回。 */
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);

  /* ══════════════════ 尺寸自适应 ══════════════════
     外接尺寸不写死，直接从场景里量出来。这样以后改环数、改卡片大小、改珠子长短，
     构图会自己跟着走 —— 不会再出现"切掉灯顶"或者"底下贴边"这类问题。 */
  const fitBox = new THREE.Box3();
  const fitTmp = new THREE.Box3();
  let fitW = 90, fitH = 100, camTargetY = CFG.cam.targetY;

  function measureAssembly() {
    const spin = head.rotation.y;
    head.rotation.y = 0;                 // 量的时候摆正，结果才与自转相位无关
    scene.updateMatrixWorld(true);
    fitBox.makeEmpty();
    head.traverse((o) => {
      if (!o.isMesh || o.isSprite) return;
      fitTmp.setFromObject(o);
      if (!fitTmp.isEmpty()) fitBox.union(fitTmp);
    });
    head.rotation.y = spin;
    if (fitBox.isEmpty()) return;
    /* 高度从地面量起（底座在 statics 里，不参与量取，所以下界固定取 0），
       上界补到顶珠的位置 */
    const topY = Math.max(fitBox.max.y, CFG.pole.to + 5.2);
    fitW = Math.max(fitBox.max.x - fitBox.min.x, fitBox.max.z - fitBox.min.z);
    fitH = topY;
    /* 视线中心略高于几何中心。相机是微微俯视的，投影会把下半部分放大一点，
       不补的话顶上会比底下更贴边（实测 6.4% vs 11.7%）—— 补一点点，两边就匀了。 */
    camTargetY = topY / 2 + fitH * 0.005;
  }

  function resize() {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    const vf = Math.tan((camera.fov * Math.PI) / 360);
    /* 1.22 是留白：实测过整盏灯在画面里的真实占位 —— 减小到 1.14 时，
       最下面那排珠子和卡片会被底边切掉，所以这个数不能凭感觉给 */
    const fit = Math.max(fitH / 2 / vf, fitW / 2 / vf / camera.aspect) * 1.22;
    minDist = fit * 0.7;
    maxDist = Math.max(fit * 2.4, 340);
    if (!fitted) { fitted = true; distT = dist = fit; }
    distT = clamp(distT, minDist, maxDist);
    sizeDim();        // 暗场面片挂在相机上，视锥一变就得重新铺满
    refitFocus();     // 正在放大看的时候改窗口，卡片要跟着重新居中
  }
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    var resizeObserver = ro;
  }
  measureAssembly();
  resize();

  /* ── 预热放大态的渲染管线 ────────────────────────────────────────────
     放大态那套材质（MeshPhysicalMaterial + sheen + roughnessMap + 环境贴图 +
     map + emissiveMap）是一整套**独立的着色器程序**，而它只在第一次真正渲染
     放大态的时候才被编译 —— 那一帧正好就是用户第一次点下去的那一帧。
     实测那一下主线程会冻住 2.1 秒（正常帧 16.8ms），就是"第一次点开会卡卡的"。
     这里在启动阶段用一次离屏渲染把它编译掉、顺便把 768×1152 的贴图上传掉。
     代价是加载多等一秒多 —— 但那时候屏幕上是"正在点亮…"，看不见卡顿；
     而把这两秒挪到点击上，就是一次明明白白的"卡"。 */
  (function warmFocusPipeline() {
    focusTex.image = paintCard({ text: '', art: null, tone: 'cream' }, 0.37, null, true);
    focusTex.needsUpdate = true;

    /* ★ 预热必须"全套上场"，只把 focusGroup 打开是不够的。
       暗场、投影、光晕这三样平时是"按需显形"的（dimMat.opacity > 0.02 才挂在场上），
       预热那一刻它们恰好是隐藏的 —— 而隐藏对象根本不进渲染列表，
       它们的材质也就不会编译。上一版只修了卡片本体，于是"第一次真放大"
       仍然要现编这三个 program，那一帧依旧卡（实测 ~83ms）。
       这里临时把它们全打开再渲一帧，编完立刻还原，画面上什么都没变。 */
    const restore = [dimMesh, focusShadow, focusHalo].map((o) => [o, o.visible]);
    const dimOpacity = dimMat.opacity;
    dimMesh.visible = focusShadow.visible = focusHalo.visible = true;
    dimMat.opacity = 0.5;
    focusGroup.visible = true;
    renderer.compile(scene, camera);        // 只编译着色器，不画
    const rt = new THREE.WebGLRenderTarget(4, 4);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);         // 真渲一帧：逼贴图走一遍上传
    renderer.setRenderTarget(prev);
    rt.dispose();
    focusGroup.visible = false;
    dimMat.opacity = dimOpacity;
    restore.forEach((pair) => { pair[0].visible = pair[1]; });
  })();


  /* ══════════════════ 主循环 ══════════════════ */
  let raf = 0, last = performance.now(), time = 0, frameNo = 0;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;

    /* 放大态下停转：卡片已经"取下来了"，灯再转只会让背景晃得眼晕 */
    if (opt.spin && !reduced && !focus) head.rotation.y += opt.autoSpin * dt;

    /* hover 拾取：三帧一次，够用又不浪费 */
    if (pointerInside && !focus && ++frameNo % 3 === 0) {
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pickMeshes, false);
      const rec = hits.length ? hits[0].object.userData.rec : null;
      for (const c of cards) c.hoverT = c === rec ? 1 : 0;
      /* 鼠标落在卡片上就变成手型 —— 不然没人知道这东西能点。
         拖动中不接管，交给 .dragging 那条 CSS 显示抓手。 */
      if (!dragging) {
        const want = rec ? 'pointer' : 'grab';
        if (canvas.style.cursor !== want) canvas.style.cursor = want;
      }
      /* 悬停停留够久（多半是要点它了）就先把放大贴图备好 —— 见 prepareFocusTex */
      if (rec !== dwellRec) { dwellRec = rec; dwellT = time; }
      else if (rec && !dragging && preparedRec !== rec && time - dwellT > 0.22) {
        prepareFocusTex(rec);
      }
    }

    windBurst *= Math.pow(0.07, dt);

    const air = reduced ? 0.25 : 1;
    for (const c of cards) {
      const s = c.spec;
      /* 三个不同频率的正弦叠起来 ≈ 自然阵风 */
      const gust =
        Math.sin(time * 0.83 + s.phase * TAU) * 0.50 +
        Math.sin(time * 1.71 + s.phase * 9.10) * 0.30 +
        Math.sin(time * 2.90 + s.phase * 3.70) * 0.15;
      const target = gust * 0.062 * air * (1 + windBurst * 2.6);

      /* 阻尼受迫振子 —— "风铃感"就是这一行 */
      c.av += (-s.omega * s.omega * (c.angle - target) - 2 * s.zeta * s.omega * c.av) * dt;
      c.angle += c.av * dt;

      c.hover += (c.hoverT - c.hover) * Math.min(1, dt * 7);
      c.swing.rotation.x = c.angle + c.hover * 0.11;
      c.swing.rotation.z = c.angle * 0.22;
      /* 正反两片共面，参数必须一致，否则hover时会看到一张"浮起来"的鬼影 */
      const boost = 0.19 + c.hover * 0.34;
      c.mat.emissiveIntensity = boost;
      c.matBack.emissiveIntensity = boost;
      const lift = c.baseY + c.hover * 1.1;
      c.mesh.position.y = lift;
      c.meshBack.position.y = lift;
    }

    /* 灯自己会呼吸，画面才不像一张静帧。
       烛光档再叠一层跳动：两个不同频率的正弦**相乘**，得到的是一条
       永远不重复的抖 —— 相加的话会听出周期，一眼就假。 */
    const breathe = 1 + Math.sin(time * 1.25) * 0.035 + Math.sin(time * 2.70) * 0.015;
    const flick = lightCfg.flicker
      ? 1 + lightCfg.flicker * (Math.sin(time * 8.7) * Math.sin(time * 3.1) - 0.5) * 1.4
      : 1;
    coreLight.intensity = coreBase * breathe * flick;
    lowLight.intensity = lowBase * (0.84 + 0.16 * flick);
    glowSprite.material.opacity = 0.95 * breathe;
    glowSprite.scale.set(84 * (1 + (breathe - 1) * 2), 84 * (1 + (breathe - 1) * 2), 1);

    if (dust) {
      const p = dust.userData.pos, v = dust.userData.vel, N = dust.userData.N;
      for (let i = 0; i < N; i++) {
        p[i * 3 + 1] += v[i] * dt;
        if (p[i * 3 + 1] > 126) p[i * 3 + 1] = -6;
      }
      dust.geometry.attributes.position.needsUpdate = true;
    }

    /* 相机阻尼 */
    theta += (thetaT - theta) * Math.min(1, dt * 8);
    phiT = clamp(phiT, ORBIT.phiMin, orbitPhiMax(distT));
    phi += (phiT - phi) * Math.min(1, dt * 8);
    dist += (distT - dist) * Math.min(1, dt * 6);
    camera.position.set(
      dist * Math.sin(phi) * Math.sin(theta),
      camTargetY + dist * Math.cos(phi),
      dist * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(0, camTargetY, 0);

    /* 放大态必须放在相机更新之后 —— 它的落点是"相机正前方"，
       相机这一帧挪过位置，落点才是准的 */
    stepFocus(dt);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  /* ══════════════════ 对外的接口 ══════════════════ */
  const api = {
    THREE, scene, camera, renderer, root, head,
    cards, focusGroup, focusMesh, focusEdge,

    /** 换卡片内容：lamp.setCards([{ text, art, tone, image }]) */
    setCards(list) {
      if (Array.isArray(list) && list.length) {
        opt.cards = list;
        preparedRec = null;            // 卡片换了，预画的贴图跟着作废
        buildCards();
        measureAssembly();   // 卡片换过之后重新量一次，构图跟着走
        resize();
      }
      return api;
    },

    /** 换灯牌字体（传字体 family 名）。换完自动重画一遍卡片 ——
        前提是那个字体已经 document.fonts 就绪，否则画出来还是回退字体。 */
    setFont(family) {
      CARD_FONT_USER = String(family || '');
      preparedRec = null;
      buildCards();
      measureAssembly();
      resize();
      return api;
    },

    /** 换骨架材质：'gunmetal'（深炭灰，默认）| 'champagne'（奶油白 + 香槟金） */
    setFrame(name) {
      const p = FRAME_PRESETS[name] || FRAME_PRESETS.gunmetal;
      const apply = (mat, cfg) => {
        mat.color.setHex(cfg.color);
        mat.metalness = cfg.metalness;
        mat.roughness = cfg.roughness;
        mat.envMapIntensity = cfg.envMapIntensity;
        mat.needsUpdate = true;
      };
      apply(matFrame, p.frame);
      apply(matAccent, p.accent);
      apply(matWire, p.wire);
      return api;
    },

    /** 来一阵风 */
    blow(power) {
      windBurst = Math.min(4, windBurst + (power == null ? 1.9 : power));
      return api;
    },

    /* ══ 放大态 ══
       lamp.focusAt(0)     把第 0 张卡拿到眼前
       lamp.focusCard('好好')  按文案找一张（包含匹配）
       lamp.blur()         放回去
       lamp.onFocus / lamp.onBlur  两个回调槽，接你自己的 UI */
    focusAt(index) {
      if (cards[index]) openFocus(cards[index]);
      return api;
    },
    focusCard(text) {
      const q = String(text || '');
      const hit = cards.find((c) => String((c.def && c.def.text) || '').indexOf(q) >= 0);
      if (hit) openFocus(hit);
      return api;
    },
    blur() { closeFocus(); return api; },
    get focused() { return focus ? focus.rec : null; },
    onFocus: null,
    onBlur: null,

    /** 开关自转 / 调速 */
    setSpin(on) { opt.spin = !!on; return api; },
    setAutoSpin(v) { opt.autoSpin = v; return api; },
    setExposure(v) { renderer.toneMappingExposure = v; return api; },
    /** 手势的当前状态。手机上"突然不听话了"先看这里：
        手指数不对 / pinching 卡在 true，就是有一根手指没被清掉。 */
    touchState() {
      return {
        touchMode, pointers: ptrs.size, pinching, dragging, pressed,
        dist: +dist.toFixed(1), focused: !!focus && !focus.closing,
      };
    },

    /** 打灯：'warm' 暖灯（默认）| 'moon' 月光 | 'day' 自然光 | 'candle' 烛光 */
    setLight(name) { applyLight(name); return api; },
    lightPresets: Object.keys(LIGHT_PRESETS),

    resize,

    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      if (typeof resizeObserver !== 'undefined' && resizeObserver) resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      if (layer.parentNode) layer.parentNode.removeChild(layer);
      focusTex.dispose();
      edgeGeo.dispose();
      matCardEdge.dispose();
      edgeMatFocus.dispose();
      focusMat.dispose();
      focusMesh.geometry.dispose();
      frostRoughTex.dispose();
      shadowTex.dispose();
      shadowMat.dispose();
      focusShadow.geometry.dispose();
      haloMat.map.dispose();     // sprite 的 geometry 是 three 内部共享的，不要动
      haloMat.dispose();
      dimTex.dispose();
      dimMat.dispose();
      dimMesh.geometry.dispose();
      clearCards();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const list = Array.isArray(o.material) ? o.material : [o.material];
          list.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
      });
      envRT.dispose();
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  };

  /* 预设表是唯一的事实来源：初始灯光由它写进去，代码里不再重复一遍色值 */
  applyLight('warm');

  return api;
}

export default createAcrylicLamp;
