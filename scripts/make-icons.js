/* ============================================================
   scripts/make-icons.js — 生成 PWA 图标（零依赖，node 直跑）
   跑法：node scripts/make-icons.js
   产出：icons/icon-192.png / icons/icon-512.png

   为什么手画 PNG：项目零依赖（用户 C 盘紧张，不装 node_modules），
   而手撸 PNG 只需要 zlib（node 自带）+ 手写 chunk/CRC。
   图案：深夜底色 + 琥珀色猫爪（跟主题色一致），直角处做圆角遮罩。
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

const BG = [30, 27, 46, 255];        /* 深夜 #1E1B2E（theme-color 同源） */
const PAD = [232, 184, 123, 255];    /* 琥珀 --amber */

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const R = size * 0.22;              /* 圆角半径 */
  /* 猫爪：一个大肉垫 + 三个脚趾，整体在画面中心偏下 */
  const cx = size / 2;
  const cy = size * 0.56;
  const padR = size * 0.185;          /* 大肉垫半径（椭圆 x 方向压一点） */
  const toeR = size * 0.085;
  const toes = [
    [cx - size * 0.21, size * 0.335],
    [cx, size * 0.285],
    [cx + size * 0.21, size * 0.335]
  ];

  function inCircle(x, y, ccx, ccy, r) {
    const dx = x - ccx, dy = y - ccy;
    return dx * dx + dy * dy <= r * r;
  }
  function inPad(x, y) {
    /* 大肉垫画成横向压扁的椭圆，底边略平 —— 用两段圆拼太啰嗦，椭圆够了 */
    const dx = (x - cx) / (padR * 1.25);
    const dy = (y - cy) / (padR * 0.92);
    return dx * dx + dy * dy <= 1;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      /* 圆角遮罩：四角以外的部分透明 */
      const rx = Math.min(x, size - 1 - x);
      const ry = Math.min(y, size - 1 - y);
      const inCorner = (rx < R && ry < R);
      let on = true;
      if (inCorner) {
        const dx = R - rx, dy = R - ry;
        on = dx * dx + dy * dy <= R * R;
      }
      let c = [0, 0, 0, 0];
      if (on) {
        c = BG.slice();
        if (inPad(x, y) || toes.some(function (t) { return inCircle(x, y, t[0], t[1], toeR); })) {
          c = PAD.slice();
        }
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
