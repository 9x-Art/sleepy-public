#!/usr/bin/env node
/* ============================================================
   serve.js — 零依赖本地开发服务器
   纯给开发时用：`pnpm dev` 起一个 http://127.0.0.1:5173

   为什么不用 vite / live-server：
     这个项目是「零依赖静态前端」，双击 index.html 就能跑。
     引构建工具会带来 node_modules、几百 MB 缓存（用户 C 盘紧张），
     而且我们不需要打包、不需要 HMR —— 改完手动刷新就够了。
     所以这里用 Node 自带的 http 模块写一个最小的静态服务器。

   用法：
     node serve.js              # 起服务，不开浏览器
     node serve.js --open       # 起服务并自动打开浏览器
     node serve.js --port=8080  # 指定端口（被占用会自动往后找）
   ============================================================ */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var zlib = require('zlib');

var ROOT = __dirname;

/* ---------------------------- 参数 ---------------------------- */

var argv = process.argv.slice(2);
var wantOpen = argv.indexOf('--open') >= 0;
/* --lan：绑 0.0.0.0，让同一 Wi-Fi 里的手机能访问（真机验收用）。
   默认仍只绑 127.0.0.1 —— 不开 --lan 时行为与原来完全一致。 */
var wantLan = argv.indexOf('--lan') >= 0;
var portArg = null;
argv.forEach(function (a) {
  var m = /^--port=(\d+)$/.exec(a);
  if (m) portArg = parseInt(m[1], 10);
});

var startPort = portArg || parseInt(process.env.PORT || '5173', 10);

/* ---------------------------- MIME ---------------------------- */
/* 只列这个项目真正会用到的类型，不做通用表 */

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

/* ---------------------------- 响应 ---------------------------- */

function send(res, code, headers, body) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendText(res, code, text) {
  send(res, code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  }, text);
}

function send404(res, rel) {
  send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' },
    '<!doctype html><meta charset="utf-8">' +
    '<div style="font:14px/1.7 ui-monospace,monospace;padding:32px">' +
    '<p><b>404</b> 找不到 ' + escapeHtml(rel) + '</p>' +
    '<p><a href="/">回首页</a></p></div>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ---------------------------- 路由 ---------------------------- */

function resolveFile(pathname) {
  /* 去掉 query / 解码 / 归一化，然后确认没跑出项目目录 */
  var clean = decodeURIComponent(pathname.split('?')[0]);
  var target = path.normalize(path.join(ROOT, clean));
  if (target !== ROOT && target.indexOf(ROOT + path.sep) !== 0) return null;
  return target;
}

function handle(req, res) {
  var urlPath = req.url || '/';

  /* 探活接口，方便脚本判断服务是否已经起来 */
  if (urlPath === '/__ping') return sendText(res, 200, 'ok');

  var file = resolveFile(urlPath);
  if (!file) return sendText(res, 403, '403 越界路径');

  fs.stat(file, function (err, st) {
    if (!err && st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = null;
    }
    if (!err && st && st.isFile()) return serveFile(res, file, urlPath, false);

    /* 目录没给 index.html 时退一步再试 */
    fs.stat(file, function (err2, st2) {
      if (!err2 && st2.isFile()) return serveFile(res, file, urlPath, false);
      /* 单页应用兜底：不认识的路径交给 index.html 自己处理 */
      var index = path.join(ROOT, 'index.html');
      fs.stat(index, function (err3, st3) {
        if (err3 || !st3.isFile()) return send404(res, urlPath);
        serveFile(res, index, urlPath, true);
      });
    });
  });
}

function serveFile(res, file, urlPath, isFallback) {
  fs.readFile(file, function (err, buf) {
    if (err) return sendText(res, 500, '500 读文件失败：' + err.message);
    var ext = path.extname(file).toLowerCase();
    var headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      /* 开发服务器一律不缓存：改完直接刷新就能看到，不用清缓存 */
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    };

    /* ---- gzip ----
       2026-09-18 加的。起因是接了亚克力灯之后用户说「加载时间有点长了qwq」——
       那次要现下 three.module.js，**671 KB 明文**。
       压完只剩 166 KB，本地上基本感觉不到等待了。

       这件事还有个更重要的理由：**真实的线上主机一定是开 gzip/brotli 的**。
       开发服务器不压，就等于我们在本地测出来的加载时间比线上难看得多，
       很容易为了一个不存在的问题去做优化（或者反过来，以为线上也这么慢）。
       本地尽量贴着线上的表现，判断才准。

       只压文本类。图片/字体已经压过了，再压一遍白费 CPU 还大一点点。 */
    var canZip = /^(text\/|application\/(javascript|json|manifest))/.test(headers['Content-Type']) ||
                 /\.(js|css|html|json|svg|mjs|map|txt|md)$/i.test(file);
    var accept = (res.req && res.req.headers && res.req.headers['accept-encoding']) || '';
    if (canZip && /\bgzip\b/.test(accept) && buf.length > 1024) {
      return zlib.gzip(buf, function (e, gz) {
        if (e || !gz || gz.length >= buf.length) {
          headers['Content-Length'] = buf.length;
          return send(res, 200, headers, buf);
        }
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = gz.length;
        headers['Vary'] = 'Accept-Encoding';
        send(res, 200, headers, gz);
        log('200', urlPath, kb(buf.length) + ' → ' + kb(gz.length) + ' (gzip)');
      });
    }

    headers['Content-Length'] = buf.length;
    send(res, 200, headers, buf);
    log('200', urlPath, buf.length);
  });
}

/* ---------------------------- 日志 ---------------------------- */
/* 只打状态码、路径、大小。不打 user-agent，太吵 */

function log(code, urlPath, size) {
  var n = '';
  if (typeof size === 'string') n = ' ' + size;          /* 已经排好版的（带 → 的压缩比） */
  else if (size != null) n = ' ' + kb(size);
  process.stdout.write('  ' + code + '  ' + urlPath + n + '\n');
}

function kb(n) { return n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'K'; }

/* ---------------------------- 启动 ---------------------------- */

function openBrowser(url) {
  var cmd, args;
  if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    var child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', function () { /* 开不了就算了，手动点地址 */ });
    child.unref();
  } catch (e) { /* 忽略 */ }
}

function listen(port, left) {
  var server = http.createServer(handle);

  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE' && left > 0) {
      process.stdout.write('  端口 ' + port + ' 被占用，换 ' + (port + 1) + '\n');
      return listen(port + 1, left - 1);
    }
    if (err.code === 'EADDRINUSE') {
      process.stdout.write('\n  端口都被占了，用 --port=8080 指定一个吧\n\n');
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, wantLan ? '0.0.0.0' : '127.0.0.1', function () {
    var url = 'http://127.0.0.1:' + port + '/';
    process.stdout.write('\n  小手机 · 开发服务器\n');
    process.stdout.write('  ' + url + '\n');
    if (wantLan) {
      /* 手机访问入口：把每块网卡的非内网回环 IPv4 都列出来 */
      var seen = {};
      var ifs = require('os').networkInterfaces();
      Object.keys(ifs).forEach(function (name) {
        (ifs[name] || []).forEach(function (it) {
          if (it.family !== 'IPv4' || it.internal) return;
          if (seen[it.address]) return;
          seen[it.address] = true;
          process.stdout.write('  局域网  http://' + it.address + ':' + port + '/   (' + name + ')\n');
        });
      });
      process.stdout.write('  （手机打不开时：看电脑有没有弹防火墙放行提示，选「允许」）\n');
    }
    process.stdout.write('  根目录 ' + ROOT + '\n');
    process.stdout.write('  Ctrl+C 停止\n\n');
    if (wantOpen) openBrowser(url);
  });
}

listen(startPort, 10);
