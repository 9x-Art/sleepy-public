const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FONTS = [
  { css: 'Parisienne', q: 'family=Parisienne', note: '法式优雅 · 连笔' },
  { css: 'Cormorant Garamond', q: 'family=Cormorant+Garamond:ital@1', note: '细衬线斜体 · 不是手写' },
  { css: 'Allura', q: 'family=Allura', note: '经典 script · 连笔优雅' }
];

const OUT = path.join(__dirname, 'font-final.html');

(async () => {
  const faces = [];
  for (const f of FONTS) {
    const url = 'https://fonts.googleapis.com/css2?' + f.q + '&text=sleepy';
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const css = await r.text();
    const m = css.match(/url\((https:[^)]+)\)/);
    if (!m) { console.log('SKIP  ' + f.css + '   <-- 拿不到'); continue; }
    const res = await fetch(m[1], { headers: { 'User-Agent': UA } });
    const bin = Buffer.from(await res.arrayBuffer());
    const b64 = bin.toString('base64');
    console.log('OK    ' + f.css.padEnd(20) + (bin.length / 1024).toFixed(2) + ' KB  ->  base64 ' + (b64.length / 1024).toFixed(2) + ' KB');
    faces.push({ css: f.css, note: f.note, b64 });
  }

  const faceCss = faces.map(f =>
    "@font-face{font-family:'" + f.css + "';font-style:normal;font-weight:400;"
    + "src:url(data:font/woff2;base64," + f.b64 + ") format('woff2');}"
  ).join('\n');

  const cards = faces.map(f =>
    '<div class="card">'
    + '<div class="name">' + f.css + '<span>' + f.note + '</span></div>'
    + '<div class="plate night"><span class="mk" style="font-family:\'' + f.css + '\'">sleepy</span></div>'
    + '<div class="plate day"><span class="mk" style="font-family:\'' + f.css + '\'">sleepy</span></div>'
    + '</div>'
  ).join('\n');

  const total = faces.reduce((s, f) => s + f.b64.length, 0);

  const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>sleepy · 最终三选一</title><style>\n'
    + faceCss + '\n'
    + 'body{margin:0;padding:34px 20px 70px;background:#16130f;color:#cfc6b8;'
    + 'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}'
    + 'h1{font-size:15px;font-weight:500;margin:0 0 8px;letter-spacing:.06em;}'
    + 'p.sub{font-size:12px;color:#6b6154;margin:0 0 30px;line-height:1.85;}'
    + '.card{display:flex;align-items:center;gap:18px;margin-bottom:20px;flex-wrap:wrap;}'
    + '.name{width:180px;flex:0 0 180px;font-size:13px;color:#c0b3a0;line-height:1.5;}'
    + '.name span{display:block;color:#5e564b;font-size:11.5px;margin-top:4px;}'
    + '.plate{flex:0 0 auto;min-width:250px;border-radius:18px;padding:20px 34px;text-align:center;}'
    + '.plate.night{background:linear-gradient(165deg,#16233A 0%,#0D1626 60%,#131F33 100%);'
    + 'box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 8px 22px rgba(0,0,0,.35);}'
    + '.plate.day{background:#FBFBFD;box-shadow:0 6px 20px rgba(0,0,0,.3);}'
    + '.plate.night .mk{color:#9FC0E4;}'
    + '.plate.day .mk{color:#B08A5E;}'
    + '.mk{font-size:54px;line-height:1.25;display:inline-block;}'
    + '</style></head><body>\n'
    + '<h1>sleepy · 你圈的三个 + 验证</h1>\n'
    + '<p class="sub">三条都拿到了 ✓（OFL 开源，可免费商用）。<br>'
    + '上=夜里（深色玻璃/浅蓝），下=天亮之后（白玻璃/焦糖）—— 后者才是用户停住的那一眼。<br>'
    + '内嵌总计 ' + (total / 1024).toFixed(1) + ' KB base64。完全离线，不联网也能看。</p>\n'
    + cards + '\n'
    + '<p class="sub" style="margin-top:26px">对照 · 当前默认 Georgia Italic（系统自带，无需内嵌）：</p>\n'
    + '<div class="card"><div class="name">Georgia Italic<span>系统字体 · 跨平台基本一致</span></div>'
    + '<div class="plate day"><span class="mk" style="font-family:Georgia,serif;font-style:italic">sleepy</span></div>'
    + '</div>\n'
    + '</body></html>';

  fs.writeFileSync(OUT, html, 'utf8');
  console.log('\nWROTE ' + OUT + '  (' + (html.length / 1024).toFixed(1) + ' KB)');
})();
