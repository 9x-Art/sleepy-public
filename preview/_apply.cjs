const fs = require('fs');
const dir = __dirname;

const ff = fs.readFileSync(dir + '/font-final.html', 'utf8');
const m = ff.match(/@font-face\{font-family:'Cormorant Garamond';font-style:normal;font-weight:400;src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\('woff2'\);\}/);
if (!m) { throw new Error('Cormorant base64 NOT FOUND'); }
const b64 = m[1];
console.log('取出 Cormorant base64 =', (b64.length / 1024).toFixed(2), 'KB');

let s = fs.readFileSync(dir + '/splash-v15.html', 'utf8');
const before = s.length;

function must(from, to, label) {
  if (s.indexOf(from) < 0) { throw new Error('ANCHOR MISS: ' + label); }
  s = s.replace(from, to);
  console.log('  ok  ' + label);
}

must(
  '  .serif { font-family: "Songti SC"',
  "@font-face{font-family:'Cormorant Garamond';font-style:normal;font-weight:400;"
    + "src:url(data:font/woff2;base64," + b64 + ") format('woff2');}\n"
    + '  .serif { font-family: "Songti SC"',
  '@font-face 内嵌'
);

must(
  '  .logo.f-sans {',
  "  .logo.f-cormorant { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 2.4em; letter-spacing: .06em; text-indent: .06em; }\n"
    + '  .logo.f-sans {',
  '.logo.f-cormorant 样式'
);

must(
  '    <button data-font="serif" class="on">衬线斜体（最稳）</button>\n    <button data-font="flower">系统花体</button>\n    <button data-font="sans">无衬线</button>',
  '    <button data-font="cormorant" class="on">Cormorant（定）</button>\n'
    + '    <button data-font="serif">Georgia 斜体</button>\n'
    + '    <button data-font="sans">无衬线</button>',
  '字形按钮'
);

must("var font = 'serif';", "var font = 'cormorant';", '默认字形');

must('<title>Sleepy 开屏预览 v15</title>', '<title>Sleepy 开屏预览 v16</title>', 'title');
must('<div class="cap">Sleepy · 开屏预览 v15</div>', '<div class="cap">Sleepy · 开屏预览 v16</div>', 'cap');
must(
  '    v15：SVG 手绘已撤回（那条路走不通，见聊天记录里那张丑图）。默认改回衬线斜体 —— 它是唯一「跨平台长得一样」的选择。',
  '    v16：sleepy 字形定为 Cormorant Garamond Italic —— OFL 免费商用，已按 s/l/e/p/y 五个字形子集化并 base64 内嵌（1.88 KB）。跨平台完全一致。',
  'note'
);

fs.writeFileSync(dir + '/splash-v16.html', s, 'utf8');
console.log('\nWROTE splash-v16.html   ' + (before / 1024).toFixed(1) + ' KB -> ' + (s.length / 1024).toFixed(1) + ' KB');
