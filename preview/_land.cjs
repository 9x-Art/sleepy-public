const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- 1. 取 Cormorant 的 base64 ---------- */
const ff = fs.readFileSync(path.join(__dirname, 'font-final.html'), 'utf8');
const bm = ff.match(/@font-face\{font-family:'Cormorant Garamond';font-style:normal;font-weight:400;src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\('woff2'\);\}/);
if (!bm) throw new Error('Cormorant base64 取不到');
const FONT_B64 = bm[1];
console.log('Cormorant base64  ' + (FONT_B64.length / 1024).toFixed(2) + ' KB');

/* ---------- 2. style.css 追加开屏样式 ---------- */
const CSS = `
/* ---------------- 开屏（冷启动遮罩） ----------------
   见 splash.js。z-index 取 300，高于 #statusbar(60)、.page(10)，
   所以连状态栏一起盖住 —— 冷启动那一屏要干净；
   摘掉遮罩时，状态栏和早就渲染好的桌面一起露出来。
   颜色刻意不写死成"手机框的颜色"，而是跟着当前主题走（见 splash.js 的 token()），
   天亮亮到 --g-base、sleepy 用 --g-accent，接回主界面不会跳色。 */
@font-face{
  font-family:'Cormorant Garamond';
  font-style:normal;
  font-weight:400;
  src:url(data:font/woff2;base64,${FONT_B64}) format('woff2');
}

#splash{
  position:absolute;inset:0;z-index:300;
  overflow:hidden;
  background:#0B1220;
  font-size:19px;
  cursor:pointer;
  -webkit-tap-highlight-color:transparent;
}
#splash .sp-stage{
  position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(125% 78% at 50% 6%,rgba(150,190,240,.30) 0%,rgba(150,190,240,0) 58%),
    linear-gradient(108deg,rgba(255,255,255,.10) 0%,rgba(255,255,255,0) 26%,rgba(255,255,255,0) 74%,rgba(180,210,245,.09) 100%),
    linear-gradient(165deg,#16233A 0%,#0D1626 52%,#131F33 100%);
}
#splash .sp-spot{
  position:absolute;left:50%;top:46%;width:190%;height:190%;
  transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;
  background:radial-gradient(circle,rgba(150,180,230,.17) 0%,rgba(150,180,230,.06) 34%,rgba(150,180,230,0) 68%);
}
#splash .sp-glow{
  position:absolute;left:50%;bottom:-100px;width:340px;height:260px;margin-left:-170px;
  border-radius:50%;filter:blur(42px);background:rgba(140,180,235,.22);
}
#splash::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.16),inset 0 -1px 0 rgba(255,255,255,.045);
}

#splash .sp-slot{position:absolute;transform:translate(-50%,-50%);text-align:center;}
#splash .sp-w{
  display:block;font-family:var(--ff-serif);
  font-size:.68em;line-height:1.4;white-space:pre-line;
  color:#E8F0FA;opacity:0;
}
#splash .sp-w.sm{font-size:.52em;}
#splash .sp-w.vert{writing-mode:vertical-rl;}

#splash .sp-slogan{
  position:absolute;left:0;right:0;top:44%;transform:translateY(-50%);
  text-align:center;opacity:0;font-family:var(--ff-serif);
  font-size:2.9em;line-height:1.5;color:#F2F7FD;
}
#splash .sp-echo{
  position:absolute;left:0;right:0;top:55%;
  text-align:center;opacity:0;
  font-size:.52em;letter-spacing:.18em;color:#F2F7FD;
}
#splash .sp-logo{
  position:absolute;left:0;right:0;top:46%;
  text-align:center;opacity:0;
  font-family:'Cormorant Garamond',Georgia,serif;
  font-size:2.4em;letter-spacing:.06em;text-indent:.06em;
}
`;

const cssPath = path.join(ROOT, 'style.css');
let css = fs.readFileSync(cssPath, 'utf8');
if (css.indexOf('#splash{') >= 0) throw new Error('style.css 里已经有 #splash 了，别重复追加');
css = css.replace(/\s*$/, '\n') + CSS;
fs.writeFileSync(cssPath, css, 'utf8');
console.log('style.css         +' + (CSS.length / 1024).toFixed(1) + ' KB');

/* ---------- 3. index.html 挂脚本 ---------- */
const htmlPath = path.join(ROOT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const anchor = '<script src="page-wj-create.js" defer></script>';
if (html.indexOf(anchor) < 0) throw new Error('index.html 找不到 page-wj-create.js 那一行');
if (html.indexOf('splash.js') >= 0) throw new Error('index.html 里已经有 splash.js 了');
html = html.replace(anchor, anchor +
  '\n<!-- 开屏（冷启动遮罩）。**必须排最后**：page-chat-settings.js 末尾的\n' +
  '     Sleepy.bootHome() 已经跑过，桌面渲染完成，遮罩下面是有内容的，\n' +
  '     摘掉遮罩那一下才不会白屏。 -->\n' +
  '<script src="splash.js" defer></script>');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log('index.html        + <script src="splash.js" defer>');

/* ---------- 4. sw.js 升版本 ---------- */
const swPath = path.join(ROOT, 'sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
const sv = sw.match(/var CACHE = 'sleepy-v(\d+)'/);
if (!sv) throw new Error('sw.js 找不到 CACHE 版本号');
const next = 'sleepy-v' + (parseInt(sv[1], 10) + 1);
sw = sw.replace("var CACHE = 'sleepy-v" + sv[1] + "'", "var CACHE = '" + next + "'");
fs.writeFileSync(swPath, sw, 'utf8');
console.log('sw.js             sleepy-v' + sv[1] + ' -> ' + next);
