/* ============================================================
   scripts/make-icons.js — 生成 PWA 图标（零依赖，node 直跑）
   跑法：node scripts/make-icons.js
   产出：icons/icon-192.png / icons/icon-512.png

   为什么手画 PNG：项目零依赖（用户 C 盘紧张，不装 node_modules），
   而手撸 PNG 只需要 zlib（node 自带）+ 手写 chunk/CRC。
   图案：深夜底色 + 琥珀色猫爪，**满幅方块不烤圆角**（见 draw() 上面的说明）。
   改图案改 draw() 就行，重跑一次脚本。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------- PNG 编码 ---------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   /* bit depth */
  ihdr[9] = 6;   /* color type: RGBA */
  /* 每行前面加一个 filter 字节（0 = 无滤波） */
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------------------- 画猫爪 ---------------------------- */

const BG = [30, 27, 46, 255];        /* 深夜 #1E1B2E：给桌面/主屏留对比，不跟 app 的纯白走 */
const PAD = [232, 184, 123, 255];    /* 琥珀 */

/* ⚠️ 必须画成**满幅方块**，不能自己烤圆角。
   这两张图在 manifest 里声明成 purpose:"any maskable"，系统会按自己的形状
   去裁（安卓 / Edge 常见是圆形）。图里已经有一层圆角的话，裁出来就是
   「圆里套着一个带深色直角的方块」—— 以前就是这么画的。
   另外猫爪整体缩到画布的 88%：maskable 的安全区是**以画布中心为圆心、
   半径 40%** 的圆，超出部分可能被裁掉，原来的趾头刚好压线。
   （2026-09-21 修，重跑本脚本覆盖 icons/ 即可） */
const SAFE_K = 0.88;

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  /* 猫爪：一个大肉垫 + 三个脚趾，整体在画面中心略偏下。
     下面所有偏移都是**相对画布中心**算的，再乘 SAFE_K 缩进安全区。 */
  const padR = size * 0.185 * SAFE_K;   /* 大肉垫半径（椭圆 x 方向压一点） */
  const toeR = size * 0.085 * SAFE_K;
  const padCy = cy + size * 0.06 * SAFE_K;
  const toes = [
    [cx - size * 0.21 * SAFE_K, cy - size * 0.165 * SAFE_K],
    [cx, cy - size * 0.215 * SAFE_K],
    [cx + size * 0.21 * SAFE_K, cy - size * 0.165 * SAFE_K]
  ];

  function inCircle(x, y, ccx, ccy, r) {
    const dx = x - ccx, dy = y - ccy;
    return dx * dx + dy * dy <= r * r;
  }
  function inPad(x, y) {
    /* 大肉垫画成横向压扁的椭圆，底边略平 —— 用两段圆拼太啰嗦，椭圆够了 */
    const dx = (x - cx) / (padR * 1.25);
    const dy = (y - padCy) / (padR * 0.92);
    return dx * dx + dy * dy <= 1;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      /* 满幅底色：没有圆角遮罩，四角也是实心的 */
      let c = BG.slice();
      if (inPad(x, y) || toes.some(function (t) { return inCircle(x, y, t[0], t[1], toeR); })) {
        c = PAD.slice();
      }
      const i = (y * size + x) * 4;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
    }
  }
  return buf;
}

/* ---------------------------- 产出 ---------------------------- */

const outDir = path.resolve(__dirname, '..', 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
[192, 512].forEach(function (size) {
  const png = encodePNG(size, size, draw(size));
  const file = path.join(outDir, 'icon-' + size + '.png');
  fs.writeFileSync(file, png);
  console.log('  写出 ' + file + '（' + Math.round(png.length / 1024) + ' KB）');
});
console.log('图标生成完毕');
