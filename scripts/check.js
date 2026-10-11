#!/usr/bin/env node
/* ============================================================
   scripts/check.js — 改完代码跑一下：`pnpm check`
   零依赖，纯 Node 自带模块。检查三件事：

   1. 每个 .js 文件过一遍语法（一个文件的语法错误不影响别的文件，
      所以必须逐个查 —— 这一步能抓到「整页白屏」这类致命问题）
   2. style.css 括号是否平衡、有没有选择器被误吞进别的规则里
      （一条没闭合的规则能悄无声息地吃掉后面几百行样式）
   3. index.html 的 <script> 列表是否覆盖了目录里所有 page-*.js
      （漏加载不报任何错，但那个页面永远不会生效）

   退出码：有问题 = 1，全绿 = 0
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..');
var problems = [];

function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function exists(f) { return fs.existsSync(path.join(ROOT, f)); }

function ok(msg) { process.stdout.write('  \u2713 ' + msg + '\n'); }
function bad(msg) {
  process.stdout.write('  \u2717 ' + msg + '\n');
  problems.push(msg);
}

/* ------------------------- 1. JS 语法 ------------------------- */

function checkJs() {
  process.stdout.write('\nJS 语法\n');
  var files = fs.readdirSync(ROOT).filter(function (f) {
    return f.endsWith('.js') && f !== 'serve.js';
  }).concat(fs.existsSync(path.join(ROOT, 'scripts'))
    ? fs.readdirSync(path.join(ROOT, 'scripts'))
        .filter(function (f) { return f.endsWith('.js'); })
        .map(function (f) { return 'scripts/' + f; })
    : []);

  if (!files.length) return bad('没找到任何 .js 文件');

  files.forEach(function (f) {
    var r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], {
      encoding: 'utf8'
    });
    if (r.status === 0) ok(f);
    else {
      var err = (r.stderr || '').split('\n').slice(0, 4).join(' ').trim();
      bad(f + ' 语法错误 -> ' + err);
    }
  });
}

/* ------------------------- 2. CSS 结构 ------------------------- */

function checkCss() {
  process.stdout.write('\nCSS 结构\n');
  if (!exists('style.css')) return bad('style.css 不存在');

  var src = read('style.css');
  /* 注释里的花括号不参与计数 */
  var code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  var open = (code.match(/\{/g) || []).length;
  var close = (code.match(/\}/g) || []).length;

  if (open !== close) {
    bad('括号不平衡：{ 有 ' + open + ' 个，} 有 ' + close + ' 个');
  } else {
    ok('括号平衡（各 ' + open + ' 个）');
  }

  /* 逐行维护一个「层类型栈」，判断每个选择器是不是站在合法位置。
     合法：栈里全是 @media / @keyframes 这类 at-rule（规则可以嵌套在里面）
     可疑：栈里只要有一层是普通规则 —— 普通规则里不可能再放选择器，
           出现就说明上面某条规则没闭合，把后面整段吞成了它的后代选择器。

     注意不能用「往上找最近一个 {」的土办法：@media 里连着写两条规则时，
     第二条的上一条是第一条规则本身，会误报。 */
  var lines = code.split('\n');
  var stack = [];
  var swallowed = [];
  lines.forEach(function (ln, i) {
    var s = ln.trim();
    var opens = (ln.match(/\{/g) || []).length;
    var closes = (ln.match(/\}/g) || []).length;

    /* 只有「净开括号」的行才算开启一个新层（单行写成 .a{color:red} 的跳过） */
    if (opens > closes && /\{\s*$/.test(s)) {
      var selector = s.replace(/\{$/, '').trim();
      var isAt = /^@/.test(selector);
      var insidePlainRule = stack.indexOf('rule') >= 0;
      var isSelectorLike = /^[.#*\[a-zA-Z@][^{}]*$/.test(selector);
      var isKeyframeStep = /^(from|to|\d+(\.\d+)?%)$/.test(selector);

      if (insidePlainRule && isSelectorLike && !isKeyframeStep) {
        swallowed.push((i + 1) + ': ' + s.slice(0, 50));
      }
      stack.push(isAt ? 'at' : 'rule');
    }
    for (var k = 0; k < closes; k++) stack.pop();
  });

  if (swallowed.length) {
    bad('有 ' + swallowed.length + ' 处选择器疑似被上层规则吞掉：');
    swallowed.slice(0, 8).forEach(function (s) {
      process.stdout.write('      ' + s + '\n');
    });
  } else {
    ok('没有被误嵌套的选择器');
  }
}

/* --------------------- 3. index.html 加载 --------------------- */

function checkLoads() {
  process.stdout.write('\n脚本加载\n');
  if (!exists('index.html')) return bad('index.html 不存在');

  var html = read('index.html');
  var pages = fs.readdirSync(ROOT).filter(function (f) {
    return /^page-.*\.js$/.test(f);
  });
  /* 引用的脚本可能带版本 query（?v=xxx，缓存破冰），先剥掉再比对 */
  var re = /<script[^>]+src=["']([^"']+)["']/g;
  var m;
  var refs = [];
  while ((m = re.exec(html))) refs.push(m[1]);
  var loadedBase = refs.map(function (r) { return r.split('?')[0]; });
  var missing = pages.filter(function (f) {
    return loadedBase.indexOf(f) < 0;
  });

  if (missing.length) {
    bad('这些文件没被 index.html 加载（页面永远不会生效）：' + missing.join(', '));
  } else {
    ok(pages.length + ' 个 page-*.js 全部已加载');
  }

  /* 反向检查：HTML 引用的文件是不是真的存在（同样忽略版本 query） */
  var gone = refs.filter(function (r) { return !exists(r.split('?')[0]); });
  if (gone.length) bad('index.html 引用了不存在的文件：' + gone.join(', '));
  else ok(refs.length + ' 个 script 引用都存在');

  /* 样式表同理 */
  var linkRe = /<link[^>]+href=["']([^"']+\.css)["']/g;
  var cssGone = [];
  while ((m = linkRe.exec(html))) {
    if (!exists(m[1])) cssGone.push(m[1]);
  }
  if (cssGone.length) bad('样式表引用失效：' + cssGone.join(', '));
  else ok('样式表引用正常');

  /* importmap 指向的引擎文件。
     单独查这一条，是因为它**不在 <script src> 里** —— 上面那个反向检查
     扫不到它。而它一旦缺失，用户在控制台看到的是
     "Failed to resolve module specifier three"，
     跟「文件根本没拷进来」差着十万八千里，能查半天。 */
  var imRe = /<script[^>]+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;
  var specs = [];
  while ((m = imRe.exec(html))) {
    var mapRe = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
    var mm;
    while ((mm = mapRe.exec(m[1]))) {
      if (/^\.?\//.test(mm[2])) specs.push(mm[2]);
    }
  }
  if (!specs.length) {
    ok('没有 importmap（三维组件用不到就无所谓）');
  } else {
    var specGone = specs.filter(function (s) { return !exists(s.replace(/^\.\//, '')); });
    if (specGone.length) bad('importmap 指向的文件不存在：' + specGone.join(', '));
    else ok('importmap 的引擎文件都在（' + specs.join(', ') + '）');
  }
}

/* ---------------------------- 汇总 ---------------------------- */

process.stdout.write('\n小手机 · 体检\n');

checkJs();
checkCss();
checkLoads();

process.stdout.write('\n');
if (problems.length) {
  process.stdout.write('  ' + problems.length + ' 个问题，上面标 \u2717 的都要看一眼\n\n');
  process.exit(1);
}
process.stdout.write('  全绿，可以刷新浏览器了\n\n');
