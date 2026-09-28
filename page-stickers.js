/* ============================================================
   page-stickers.js — 表情包管理（聊天 App ·「我」里的一个入口）

   《聊天 App · 核心架构》图上的「表情包管理（可选择同步到全局）」。

   数据：stickers: [{ id, name, url | mediaId, group, global, sandboxId, at }]
     · `name` 是这张图的**解释**（写给自己看的：这个表情什么意思）
     · `url` 外链图 / `mediaId` 本地图（本体在 IndexedDB，见 media.js）
     · `group` 分组名（小熊 / 猫猫…），空的就是「未分组」
     · 默认**按房**（sandboxId 由 core.tagScope() 盖章）
     · 开了「同步到全局」→ global: true，哪间房都看得见

   ---- 批量导入（用户要的）----
   一次贴一堆，每行一条。三种写法都认：

     解释：URL      （全角冒号）
     解释:URL       （半角冒号）
     URL 解释       （空格分隔）

   反着写（URL 在前）也认 —— 判断方式是**哪边长得像网址**，
   不是「谁在前面」。见 parseLines()（纯函数，冒烟里单测）。

   本地图片也收：走 media.js 压到 1600 存 IndexedDB，
   localStorage 里只留一个 mediaId（以前只敢收 URL，就是因为塞不下）。

   依赖：store.js、core.js、ui.js、app.js、media.js
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var store = Sleepy.store;
  var core = Sleepy.core;

  var h = ui.h;
  var group = ui.group;

  var UNGROUPED = '未分组';

  var SVG = 'viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  function all() {
    var list = store.get('stickers');
    return Array.isArray(list) ? list : [];
  }

  /* 这一间房看得见的：全局的 + 本房的。**写入方永远用 all()** ——
     拿过滤过的列表回写会把别的房的、全局的表情整批抹掉（S4a 踩过的坑）。 */
  function visible() {
    var sid = core.scopeId();
    return all().filter(function (s) {
      return s.global || !sid || s.sandboxId === sid;
    });
  }

  function save(list) { store.set('stickers', list); }

  function groupOf(s) { return (s && s.group) || UNGROUPED; }

  /* 按出现顺序列出分组（不排序：用户自己排的顺序就是顺序） */
  function groupsOf(list) {
    var names = [];
    (list || []).forEach(function (s) {
      var g = groupOf(s);
      if (names.indexOf(g) < 0) names.push(g);
    });
    return names;
  }

  /* 从 URL 尾段猜个名字：去参数、去扩展名、截 12 字。猜得不合适还能改。 */
  function nameFromUrl(url) {
    var tail = String(url).split('?')[0].split('#')[0].split('/').pop() || '';
    tail = tail.replace(/\.[a-z0-9]{1,5}$/i, '');
    return tail.slice(0, 12) || '表情';
  }

  function looksLikeUrl(s) {
    return /^https?:\/\//i.test(String(s || '').trim());
  }

  /* 把解释里的分隔符去掉：前后的冒号、破折号、多余空白。
     「小猫委屈：」→「小猫委屈」。 */
  function cleanName(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/^[：:、，,\-–—\s]+/, '')
      .replace(/[：:、，,\-–—\s]+$/, '')
      .trim();
  }

  /* ---------------------------- 批量解析 ----------------------------

     parseLines(text) → { items: [{ url, name }], bad: [原始行] }

     每行一条，三种写法都认（用户原话：「格式大概有解释：URL，解释:URL，
     URL 解释这三种」）。

     ⚠️ 顺序很重要：**必须先用正则把网址整条抓出来，再谈剩下的**。
     不能按冒号切 —— 网址自己就带着一个冒号（https:），一切就把它劈开了：
       小熊打招呼 https://x.test/hi.gif
       切成「小熊打招呼 https」+「//x.test/hi.gif」，两边都不像网址。
     （这个 bug 是冒烟里的用例抓出来的，别改回按冒号切。）

     行首 # 或 // 当注释跳过；空行跳过；没找到网址的行进 bad。 */
  function parseLines(text) {
    var items = [];
    var bad = [];

    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = String(raw).trim();
      if (!line) return;
      if (line.charAt(0) === '#' || line.slice(0, 2) === '//') return;

      /* ① 首选：整条带协议的网址 */
      var m = /https?:\/\/[^\s]+/i.exec(line);
      if (m) {
        var url = m[0];
        var rest = line.slice(0, m.index) + ' ' + line.slice(m.index + url.length);
        items.push({ url: url, name: cleanName(rest) || nameFromUrl(url) });
        return;
      }

      /* ② 没写协议：找一个「长得像域名开头」的 token */
      var parts = line.split(/\s+/);
      var at = -1;
      for (var i = 0; i < parts.length; i++) {
        if (/^[\w.-]+\.[a-z]{2,}\//i.test(parts[i])) { at = i; break; }
      }
      if (at >= 0) {
        var url2 = parts[at];
        /* 名字 = 除网址之外的部分，按原顺序拼回去（一行里解释有好几个词） */
        var name2 = parts.filter(function (_, k) { return k !== at; }).join(' ');
        items.push({ url: url2, name: cleanName(name2) || nameFromUrl(url2) });
        return;
      }

      /* ③ 都不像：兜底当「解释:网址」，网址只要带斜杠就收 */
      var c = /^([\s\S]*?)[：:]([\s\S]*)$/.exec(line);
      if (c) {
        var tail = c[2].trim().split(/\s+/)[0];
        if (/\//.test(tail)) {
          items.push({ url: tail, name: cleanName(c[1]) || nameFromUrl(tail) });
          return;
        }
      }
      bad.push(line);
    });

    return { items: items, bad: bad };
  }

  /* ---------------------------- 写 ---------------------------- */

  /* items: [{ url } 或 { mediaId, name }]，groupName 可空 */
  function addBatch(items, groupName) {
    var list = all();
    var gn = String(groupName || '').trim() || UNGROUPED;
    var added = [];

    (items || []).forEach(function (it) {
      if (!it) return;
      var rec;
      if (it.mediaId) {
        rec = { mediaId: it.mediaId, name: it.name || '表情' };
      } else if (it.url) {
        rec = { url: it.url, name: it.name || nameFromUrl(it.url) };
      } else {
        return;
      }
      rec.id = core.newId('st');
      rec.group = gn;
      rec.global = false;
      rec.at = Date.now();
      /* 盖章。漏盖 = 这张表情在任何房里都看不见（静默丢数据） */
      core.tagScope(rec);
      list.push(rec);
      added.push(rec);
    });

    if (added.length) save(list);
    return added;
  }

  /* 老的单个添加口子（冒烟和别处还在用）：add(url) 或 add({url, name, group}) */
  function add(urlOrObj, groupName) {
    var it = (typeof urlOrObj === 'string') ? { url: urlOrObj } : (urlOrObj || {});
    if (it.url && !looksLikeUrl(it.url)) {
      return { ok: false, message: '得是 http/https 开头的地址' };
    }
    if (!it.url && !it.mediaId) return { ok: false, message: '没有内容' };
    var added = addBatch([it], groupName || it.group);
    if (!added.length) return { ok: false, message: '没存进去' };
    return { ok: true, item: added[0] };
  }

  function remove(id) {
    var hit = null;
    var keep = all().filter(function (s) {
      if (s.id === id) { hit = s; return false; }
      return true;
    });
    save(keep);
    /* 本地图的本体也删掉，不然 blob 永远烂在 IndexedDB 里 */
    if (hit && hit.mediaId && Sleepy.media) {
      Sleepy.media.remove(hit.mediaId).catch(function () { /* 忽略 */ });
    }
  }

  function update(id, patch) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined) {
          list[i][k] = patch[k];
        }
      }
    }
    save(list);
  }

  function setGlobal(id, on) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      list[i].global = !!on;
      /* 开全局就不再属于哪间房 —— 否则「同步到全局」之后拆掉那间房，
         表情会跟着被删， global 就名不副实了 */
      if (on) delete list[i].sandboxId;
      break;
    }
    save(list);
  }

  /* 整组同步到全局（2026-09-28 用户补的批量口）：
     「我-表情包」的行注写着「可同步到所有岛 · 所有账号」，但以前只有
     单张详情里藏着一个开关，一组一张张点太费劲。组头「同步」钮走这里。
     开=整组 global:true 并摘房章；关=整组 global:false（房章不回补 ——
     与单张开关同口径，关掉后哪间房都还看得见，属既有语义）。 */
  function setGroupGlobal(groupName, on) {
    var list = all();
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || groupOf(list[i]) !== groupName) continue;
      list[i].global = !!on;
      if (on) delete list[i].sandboxId;
      n++;
    }
    if (n) save(list);
    return n;
  }

  /* 上移 / 下移：换的是**全量列表**里的位置（顺序就是数组顺序）。 */
  function move(id, dir) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var j = i + dir;
      if (j < 0 || j >= list.length) return;
      var t = list[i]; list[i] = list[j]; list[j] = t;
      break;
    }
    save(list);
  }

  /* ---------------------------- 按文字找表情 ----------------------------

     match(query, limit) → 命中的表情（按相关度排）

     聊天里打字时用：输入的文字和某张表情的**解释**对得上，就把它推荐上去。
     打分从紧到松：

       解释和输入一模一样        100
       解释里含这段输入           80 − 少的那几个字   （「小熊」命中「小熊打招呼」）
       这段输入含整个解释         60 − 少的那几个字   （「小熊打招呼啊」也命中）
       输入的每个字都出现过       30                  （打一半也能命中）

     同分的新的在前。纯函数（内部读的是当前沙盒可见的那份），方便单测。 */
  function match(query, limit) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];

    var out = [];
    visible().forEach(function (s) {
      var n = String(s.name || '').trim().toLowerCase();
      if (!n) return;

      var score = 0;
      if (n === q) score = 100;
      else if (n.indexOf(q) >= 0) score = 80 - Math.min(30, n.length - q.length);
      else if (q.indexOf(n) >= 0) score = 60 - Math.min(20, q.length - n.length);
      else if (q.length >= 2) {
        var hit = 0;
        for (var i = 0; i < q.length; i++) {
          if (n.indexOf(q.charAt(i)) >= 0) hit++;
        }
        if (hit === q.length) score = 30;
      }

      if (score > 0) out.push({ s: s, score: score, at: s.at || 0 });
    });

    out.sort(function (a, b) { return b.score - a.score || b.at - a.at; });
    return out.slice(0, limit || 12).map(function (x) { return x.s; });
  }

  /* 给模型的说明书：它手上有哪些表情、想发的时候怎么写。
     聊天每次请求前会把它塞进 system（见 page-chat 的 buildMessages）。
     **只列名字**（名字就是解释）—— 模型不需要知道 URL，甚至不需要知道
     这图长什么样；它只管「想发哪个意思」。 */
  function replySpec() {
    var names = visible().map(function (s) { return String(s.name || '').trim(); })
      .filter(function (n) { return n; }).slice(0, 40);
    if (!names.length) return '';
    return '【表情包】你手边有这些表情（名字就是它的意思）：' + names.join('、') + '。\n' +
      '想发的时候**单独占一行**写 [表情:名字]（用上面列出的名字，一字不差），' +
      '系统会把它变成一张真的表情图发过去。别每句都发 —— 只在真的想发的时候用。';
  }

  /* 显示地址：本地图要现取 objectURL（异步），外链直接用 */
  function srcOf(s) {
    if (!s) return Promise.resolve('');
    if (s.mediaId && Sleepy.media) return Sleepy.media.url(s.mediaId);
    return Promise.resolve(s.url || '');
  }

  /* 选本地图片（可多选）→ 压缩 → 存图库 → 返回 [{mediaId, name}] */
  function pickLocalFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.resolve([]);
    var m = Sleepy.media;
    var out = [];
    var failed = 0;

    /* 串行：一次解码一堆大图会把手机内存顶爆 */
    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () {
        return m.shrink(f).then(function (r) {
          return m.put(r.blob, { name: f.name, kind: 'sticker', w: r.w, h: r.h })
            .then(function (id) {
              out.push({ mediaId: id, name: (f.name || '').replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 12) || '表情' });
            });
        }, function () { failed++; });
      });
    });

    return chain.then(function () {
      return { items: out, failed: failed };
    });
  }

  /* ---------------------------- 选文件 ----------------------------

     两个「不是图片」的入口：
       · pickTextFile —— 选一个 .txt / .md / .csv，读成字符串
       · pickLocalFiles —— 选图片，压好存进图库（下面那个）

     用户原话：「导入文件是指导入 txt 或者什么的文件格式，里面的内容其实还是
     url 那些」—— 所以文本文件读出来还是交给 parseLines 那三种格式去解析。 */

  function pickTextFile() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.md,.csv,.text,text/plain';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (input.parentNode) input.parentNode.removeChild(input);
        if (!f) { resolve(null); return; }
        var fr = new FileReader();
        fr.onerror = function () { resolve({ error: '这个文件读不出来' }); };
        fr.onload = function () {
          resolve({ name: f.name || '导入.txt', text: String(fr.result || '') });
        };
        fr.readAsText(f);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  /* 从文件名猜分组：「小熊.txt」→「小熊」。猜不出就用未分组。 */
  function groupFromFileName(name) {
    return String(name || '')
      .replace(/\.[a-z0-9]{1,6}$/i, '')          /* 去扩展名 */
      .replace(/表情包?|stickers?/gi, '')           /* 去「表情包」这种通用词 */
      .replace(/^[\s\-_·]+|[\s\-_·]+$/g, '')  /* 去首尾的分隔符（猫猫- → 猫猫） */
      .trim()
      .slice(0, 12);
  }

  /* ---------------------------- 导入浮层 ----------------------------

     三条路都汇到这里：
       · 右上角「导入文件」→ 选 txt，按行解析（三种写法见 parseLines）
       · 底部「选本地图片」→ 选图，压好存进图库
       · 组里那个「+」格子 → 直接进那一组，不弹这个浮层

     前两条会弹这个浮层：**确认组名 + 再把另一条也补上**，一起导入。

     **没有复制粘贴框** —— 用户：「右上角这个就当做导入文件格式的，
     不需要复制粘贴」。那条路整个去掉了（parseLines 还在，解析文件内容用它）。 */
  function openImport(ctx, onDone, pre) {
    pre = pre || {};
    var host = document.getElementById('phone') || document.body;
    var mask = h('div', 'dl-mask stk-import');
    var card = h('div', 'dl-card');

    var items = (pre.items || []).slice();      /* 已经攒好的（文件读来的 / 选好的图） */
    var chosen = items.filter(function (it) { return it.mediaId; });
    var fromFile = items.length - chosen.length;

    card.appendChild(h('div', 'dl-title', '导入表情'));
    card.appendChild(h('div', 'dl-note',
      pre.fileName
        ? '文件「' + pre.fileName + '」里读到 ' + fromFile + ' 条。'
        : '选几张本地图片（可多选）。'));

    var groupField = ui.textField({
      label: '放进哪个分组',
      hint: '比如「小熊」「猫猫」· 不填就是「未分组」',
      value: pre.groupHint || lastGroup || '',
      placeholder: '小熊'
    });
    card.appendChild(groupField.el);

    /* 另一半入口：从文件来的还能补几张本地图，反过来也一样 */
    var fileNote = h('p', 'stk-file-note', '');
    var localBtn = ui.button('再选几张本地图片', 'ghost', function () { imgInput.click(); });
    card.appendChild(localBtn);

    var imgInput = document.createElement('input');
    imgInput.type = 'file';
    imgInput.accept = 'image/*';
    imgInput.multiple = true;
    imgInput.style.display = 'none';
    imgInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(imgInput.files || []);
      if (!files.length) return;
      localBtn.disabled = true;
      fileNote.textContent = '正在处理 ' + files.length + ' 张…';
      pickLocalFiles(files).then(function (r) {
        localBtn.disabled = false;
        chosen = chosen.concat(r.items);
        fileNote.textContent = '已经收好 ' + chosen.length + ' 张本地图' +
          (r.failed ? '（' + r.failed + ' 张读不出来）' : '');
      }, function () {
        localBtn.disabled = false;
        fileNote.textContent = '这几张没读成功';
      });
    });
    card.appendChild(imgInput);
    card.appendChild(fileNote);

    var acts = h('div', 'dl-acts');
    /* 用 dl-btn（对话框自己的按钮样式），跟 ui.prompt 那套长一样 */
    var cancel = h('button', 'dl-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { close(); });
    var ok = h('button', 'dl-btn dl-btn-ok', '导入');
    ok.type = 'button';
    ok.addEventListener('click', function () { submit(); });
    acts.appendChild(cancel);
    acts.appendChild(ok);
    card.appendChild(acts);

    mask.appendChild(card);
    host.appendChild(mask);
    setTimeout(function () { mask.classList.add('is-open'); card.classList.add('is-open'); }, 20);

    function close() {
      mask.classList.remove('is-open');
      card.classList.remove('is-open');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
    }

    function submit() {
      var gn = groupField.get();
      var all = items.concat(chosen.filter(function (c) { return items.indexOf(c) < 0; }));
      if (!all.length) {
        ctx.toast('还没有内容可以导入', 'warn');
        return;
      }
      var added = addBatch(all, gn);
      lastGroup = String(gn || '').trim();
      close();
      onDone();
      ctx.toast('收下 ' + added.length + ' 张', 'ok');
    }
  }

  /* 记住上次填的分组名：连着导几批同一个分组时不用每次重打 */
  var lastGroup = '';

  /* ---------------------------- 单张的详情 ----------------------------

     网格上一格就是一张图，放不下开关和删除，所以点开这一层：
     大图 + 解释（url 对应的那段文字）+ 同步到全局 + 删除。 */
  function openSticker(ctx, s, onDone) {
    var host = document.getElementById('phone') || document.body;
    var mask = h('div', 'dl-mask stk-detail');
    var card = h('div', 'dl-card');

    card.appendChild(h('div', 'dl-title', s.name || '表情'));
    card.appendChild(h('div', 'dl-note',
      s.mediaId ? '本地图（存在图库里）' : '外链图'));

    var preview = h('div', 'stk-detail-img');
    srcOf(s).then(function (src) {
      if (src) preview.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
    });
    card.appendChild(preview);

    /* 解释 —— 用户要的「url 要对应文字解释」，所以这里是第一位可改的东西 */
    var nameField = ui.textField({
      label: '解释',
      hint: '这个表情是什么意思 · 比如「小熊打招呼」',
      value: s.name || '',
      placeholder: '小熊打招呼'
    });
    card.appendChild(nameField.el);

    var swRow = h('div', 'set-row stk-detail-sw');
    swRow.appendChild(h('span', 'set-row-label', '同步到全局'));
    var right = h('div', 'set-row-right');
    var sw = h('label', 'set-switch');
    var cb = h('input');
    cb.type = 'checkbox';
    cb.checked = !!s.global;
    sw.appendChild(cb);
    sw.appendChild(h('span', 'set-switch-track'));
    right.appendChild(sw);
    swRow.appendChild(right);
    card.appendChild(swRow);
    card.appendChild(h('div', 'stk-detail-hint',
      s.global ? '哪间房都看得见' : '只有这间房有'));

    var acts = h('div', 'dl-acts');
    /* 红色主按钮：dl-btn-ok 才是那个实心底，is-danger 把底换成珊瑚红 */
    var del = h('button', 'dl-btn dl-btn-ok is-danger', '删除');
    del.type = 'button';
    del.addEventListener('click', function () {
      ui.confirm({
        title: '删掉「' + (s.name || '表情') + '」？',
        note: s.global ? '它是全局的，哪间房都会少这一张。' : '只影响这间房。',
        ok: '删掉',
        danger: true
      }).then(function (yes) {
        if (!yes) return;
        remove(s.id);
        close();
        onDone();
      });
    });
    var cancel = h('button', 'dl-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { close(); });
    var ok = h('button', 'dl-btn dl-btn-ok', '保存');
    ok.type = 'button';
    ok.addEventListener('click', function () {
      update(s.id, { name: String(nameField.get() || '').trim() });
      setGlobal(s.id, cb.checked);
      close();
      onDone();
    });
    acts.appendChild(cancel);
    acts.appendChild(del);
    acts.appendChild(ok);
    card.appendChild(acts);

    mask.appendChild(card);
    host.appendChild(mask);
    setTimeout(function () { mask.classList.add('is-open'); card.classList.add('is-open'); }, 20);

    function close() {
      mask.classList.remove('is-open');
      card.classList.remove('is-open');
      setTimeout(function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }, 220);
    }
  }

  /* ---------------------------- 屏 ---------------------------- */

  Sleepy.register('stickers', {
    title: '表情包',
    render: function (ctx) {
      var body = ctx.body;

      /* 右上角 = **导入文件**（txt / md / csv，里面一行一条）
         用户：「右上角这个就当做导入文件格式的」。 */
      ctx.setActions([
        {
          label: '导入文件',
          svg: '<svg ' + SVG + '><path d="M7 4.5h6.5L18 9v10.5H7z"/>' +
            '<path d="M13.5 4.5V9H18"/><path d="M12 11.5v5M9.8 13.7 12 11.5l2.2 2.2"/></svg>',
          onClick: function () { importFromFile(); }
        }
      ]);

      var g = group('我的表情',
        '每组最前面那个「+」是往这一组加图片；右上角那个是导入 txt 这类文件。');

      var listWrap = h('div', 'stk-list');
      g.card.appendChild(listWrap);
      body.appendChild(g.wrap);

      var addRow = h('div', 'cfg-add-row');
      var addBtn = h('button', 'cfg-add-main', '选本地图片（可多选）');
      addBtn.type = 'button';
      addBtn.addEventListener('click', function () {
        pickImages(function (items) {
          openImport(ctx, rebuild, { items: items, groupHint: lastGroup });
        });
      });
      addRow.appendChild(addBtn);
      body.appendChild(addRow);

      body.appendChild(h('p', 'set-foot',
        '文件里每行一条：解释：网址 / 解释:网址 / 网址 解释 —— 三种都认。'));

      /* 选本地图（可多选）→ 压好存图库 → 交给 cb。两条路（底部按钮、组里的 +）共用 */
      function pickImages(cb) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        input.addEventListener('change', function () {
          var files = Array.prototype.slice.call(input.files || []);
          if (input.parentNode) input.parentNode.removeChild(input);
          if (!files.length) return;
          pickLocalFiles(files).then(function (r) {
            if (!r.items.length) { ctx.toast('这些图都没读成功', 'err'); return; }
            cb(r.items);
          });
        });
        document.body.appendChild(input);
        input.click();
      }

      /* 右上角：选一个 txt 读出来，按行解析（内容还是那三种写法） */
      function importFromFile() {
        pickTextFile().then(function (r) {
          if (!r) return;
          if (r.error) { ctx.toast(r.error, 'err'); return; }

          var parsed = parseLines(r.text);
          if (!parsed.items.length) {
            ctx.toast(parsed.bad.length
              ? '文件里没有认得出来的行（比如「' + parsed.bad[0].slice(0, 14) + '」）'
              : '这个文件是空的', 'warn');
            return;
          }
          /* 分组名先从文件名猜（「小熊.txt」→「小熊」），弹层里还能改 */
          openImport(ctx, rebuild, {
            items: parsed.items,
            fileName: r.name,
            groupHint: groupFromFileName(r.name)
          });
          if (parsed.bad.length) {
            ctx.toast('有 ' + parsed.bad.length + ' 行没看懂，先收认得出来的', 'warn');
          }
        });
      }

      /* 哪个组是展开的。默认**全收起** —— 用户：「原本每个分组是收起来的，
         点击某个地方展开」。收起时一眼看得到有哪几组、各有几张；
         只有一组时默认展开（不然点进来是个空壳，还要再点一下）。 */
      var openGroups = {};

      function rebuild() {
        var list = visible();
        var names = groupsOf(list);
        listWrap.innerHTML = '';
        if (!list.length) {
          listWrap.appendChild(h('p', 'cfg-empty',
            '一个表情都没有 · 右上角导入一个 txt，或者点下面的按钮选图片'));
          return;
        }

        names.forEach(function (gn) {
          var inGroup = list.filter(function (s) { return groupOf(s) === gn; });
          if (openGroups[gn] === undefined) openGroups[gn] = (names.length === 1);
          var open = !!openGroups[gn];

          var sec = h('div', 'stk-group' + (open ? ' is-open' : ''));

          /* 组头拆成两个按钮（**不能把 button 嵌在 button 里**）：
             左边那块点一下展开/收起，右边「改名」单独一个。 */
          var head = h('div', 'stk-group-head');

          var toggle = h('button', 'stk-group-toggle');
          toggle.type = 'button';
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          var arrow = h('span', 'stk-group-arrow');
          arrow.innerHTML = '<svg ' + SVG + '><path d="M9.5 6.5 15 12l-5.5 5.5"/></svg>';
          toggle.appendChild(arrow);
          toggle.appendChild(h('span', 'stk-group-name', gn));
          toggle.appendChild(h('span', 'stk-group-n', inGroup.length + ' 张'));
          toggle.addEventListener('click', function () {
            openGroups[gn] = !openGroups[gn];
            rebuild();
          });
          head.appendChild(toggle);

          var rename = h('button', 'stk-group-op', '改名');
          rename.type = 'button';
          rename.addEventListener('click', function () {
            ui.prompt({
              title: '这一组叫什么',
              value: gn === UNGROUPED ? '' : gn,
              placeholder: '小熊 / 猫猫 / 工作',
              ok: '改'
            }).then(function (v) {
              if (v === null) return;
              var next = String(v).trim() || UNGROUPED;
              inGroup.forEach(function (s) { update(s.id, { group: next }); });
              rebuild();
            });
          });
          head.appendChild(rename);

          /* 整组同步到全局（批量口）：全组已 global 就显示「收回本岛」，
             点一下整组翻转 —— 单张细粒度仍在详情里。 */
          var allGlobal = inGroup.length && inGroup.every(function (s) { return !!s.global; });
          var sync = h('button', 'stk-group-op', allGlobal ? '收回本岛' : '同步到全局');
          sync.type = 'button';
          sync.addEventListener('click', function () {
            var on = !allGlobal;
            var n = setGroupGlobal(gn, on);
            rebuild();
            ctx.toast(on ? ('已把「' + gn + '」的 ' + n + ' 张同步到所有岛')
                         : ('已把「' + gn + '」的 ' + n + ' 张收回本岛'), 'ok');
          });
          head.appendChild(sync);
          sec.appendChild(head);

          if (open) {
            var grid = h('div', 'stk-grid');

            /* **组里第一格是「+」** —— 单独往这一组加图片（可多选，选一张就是单张）。
               用户：「加入单张图片可以在每个组的最前面加一个这样的单独加」。 */
            var addCell = h('div', 'stk-item');
            var addBtnCell = h('button', 'stk-cell stk-cell-add');
            addBtnCell.type = 'button';
            addBtnCell.title = '往「' + gn + '」加图片';
            addBtnCell.innerHTML = '<svg ' + SVG + '><path d="M12 6.5v11M6.5 12h11"/></svg>';
            addBtnCell.addEventListener('click', function () {
              pickImages(function (items) {
                var n = addBatch(items, gn).length;
                rebuild();
                if (n) ctx.toast('往「' + gn + '」加了 ' + n + ' 张', 'ok');
              });
            });
            addCell.appendChild(addBtnCell);
            grid.appendChild(addCell);

            inGroup.forEach(function (s) {
              var item = h('div', 'stk-item');
              var cell = h('button', 'stk-cell');
              cell.type = 'button';
              cell.title = s.name || '表情';
              srcOf(s).then(function (src) {
                if (src) cell.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
                else cell.classList.add('is-missing');
              });
              cell.addEventListener('click', function () {
                openSticker(ctx, s, rebuild);
              });
              item.appendChild(cell);
              item.appendChild(h('span', 'stk-cell-name', s.name || '未命名'));
              grid.appendChild(item);
            });

            sec.appendChild(grid);
          }

          listWrap.appendChild(sec);
        });
      }
      rebuild();
      ctx.rebuild = rebuild;
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* 对外：冒烟断言用（写 / 读 / 开关落盘 / 批量解析都不用起浏览器） */
  Sleepy.stickers = {
    all: all,
    match: match,
    replySpec: replySpec,
    pickTextFile: pickTextFile,
    groupFromFileName: groupFromFileName,
    visible: visible,
    groupsOf: groupsOf,
    groupOf: groupOf,
    parseLines: parseLines,
    add: add,
    addBatch: addBatch,
    pickLocalFiles: pickLocalFiles,
    srcOf: srcOf,
    remove: remove,
    update: update,
    setGlobal: setGlobal,
    setGroupGlobal: setGroupGlobal,
    move: move,
    UNGROUPED: UNGROUPED
  };

})(window);
