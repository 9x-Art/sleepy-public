/* ============================================================
   page-worldbook.js — 世界书（模块 B，两级结构）
   依赖：store.js、ui.js、app.js
   页面：worldbook（书列表）→ worldbook-open（书内条目）
        → worldbook-book-edit（新建/编辑书）
        → worldbook-entry-edit（新建/编辑条目）

   结构（用户定的）：一级是「世界书」，二级是书里的条目。
   书分两种：
     - 全局（scope:'global'）：所有对话都可能用到
     - 个人（scope:'personal'）：挂在某个角色身上，只有聊到
       那个角色才召回。挂谁用聊天页那套「挑角色」浮层复用。

   ---- 文件格式（导出 / 导入）----
   纯文本。书用「===== 世界书：名 =====」分隔，书头下面、第一个
   条目之前可以有两行元信息；条目用「===== 条目：名 | 关键词：… =====」：

     ===== 世界书：青岚镇设定 =====
     范围：个人
     挂角色：阿岚
     ===== 条目：北门渡口 | 关键词：北门，渡口 =====
     正文……

   只有条目、没有书头的老文件也能导：整包进一本新书（全局），
   名字取文件名 —— 上一版的导出文件照导不误。
   酒馆(SillyTavern)的 json 世界书一律识别并明确拒收（B2）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var textField = ui.textField;
  var textArea = ui.textArea;
  var button = ui.button;
  var downloadText = ui.downloadText;
  var pickTextFile = ui.pickTextFile;

  /* 条目头 / 书头。条目只认「条目：」，书只认「世界书：」——
     两个层级不能混在一个正则里，否则解析时不知道切到哪层。 */
  var ENTRY_HEAD_RE = /^={3,}\s*条目\s*[：:]\s*(.+?)\s*={3,}$/;
  var BOOK_HEAD_RE = /^={3,}\s*世界书\s*[：:]\s*(.+?)\s*={3,}$/;
  var KEYLINE_RE = /^(?:关键词|触发词|keys)\s*[：:]\s*(.+)$/i;
  var META_SCOPE_RE = /^范围\s*[：:]\s*(.+)$/;
  var META_CHAR_RE = /^(?:挂角色|角色)\s*[：:]\s*(.+)$/;

  /* 右上角图标，全项目同一套线性 SVG（currentColor 跟主题走） */
  var ICON_IMPORT =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/>' +
    '<path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/></svg>';

  var ICON_EXPORT =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/>' +
    '<path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/></svg>';

  /* ---------------------------- 数据 ---------------------------- */

  function getBooks() {
    var list = store.get('worldbooks');
    return Array.isArray(list) ? list : [];
  }

  /* return 不能漏 —— store 先写内存缓存再落盘，漏了 return 会出现
     「其实存进去了但页面弹保存失败」 */
  function saveBooks(list) { return store.set('worldbooks', list); }

  function newId(pfx) {
    return (pfx || 'wb') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function findBook(id) {
    var list = getBooks();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function splitKeys(s) {
    return String(s || '').split(/[,，、;；]+/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
  }

  function charName(id) {
    var chars = store.get('characters') || [];
    for (var i = 0; i < chars.length; i++) {
      if (chars[i].id === id) return chars[i].name;
    }
    return '';
  }

  function charIdByName(name) {
    var chars = store.get('characters') || [];
    var n = String(name || '').trim();
    for (var i = 0; i < chars.length; i++) {
      if (chars[i].name === n) return chars[i].id;
    }
    return null;
  }

  /* 书卡片上的那行小字 */
  function bookSummary(b) {
    var n = (b.entries || []).length;
    var scope = b.scope === 'personal'
      ? ('个人 · 挂在 ' + (charName(b.characterId) || '（还没选角色）'))
      : '全局';
    return scope + ' · ' + n + ' 条';
  }

  /* ------------------------- 纯函数：序列化 / 解析 ------------------------- */

  function entryHead(it) {
    var ks = splitKeys(it.keys).join('，');
    return '===== 条目：' + (it.name || '未命名') +
           (ks ? ' | 关键词：' + ks : '') + ' =====';
  }

  /* 一本书 → 文本。meta 行放在书头和第一个条目之间。 */
  function bookToText(b) {
    var out = '===== 世界书：' + (b.name || '未命名') + ' =====\n';
    out += '范围：' + (b.scope === 'personal' ? '个人' : '全局') + '\n';
    if (b.scope === 'personal') out += '挂角色：' + (charName(b.characterId) || '（未选）') + '\n';
    (b.entries || []).forEach(function (it) {
      out += entryHead(it) + '\n' + (it.content || '') + '\n';
    });
    return out;
  }

  function allBooksToText(books) {
    var out = '';
    books.forEach(function (b) {
      out += bookToText(b);
    });
    return out;
  }

  /* 头里的「名字 | 关键词：a，b」拆开 */
  function parseHead(rest) {
    var name = rest;
    var keys = '';
    var bar = String(rest).split('|');
    if (bar.length > 1) {
      name = bar[0];
      for (var i = 1; i < bar.length; i++) {
        var m = bar[i].match(/^\s*(?:关键词|触发词|keys)\s*[：:]\s*(.+)$/i);
        if (m) keys = m[1];
      }
    }
    return { name: String(name).trim(), keys: keys.trim() };
  }

  /* 解析一本书内的条目段。lines 里遇到书头要停（调用方负责切片，
     这里只管条目）。meta 开关由 opts.meta 控制（书内解析时书头下的
     范围/挂角色两行由 book 层吃掉，不会到这里）。 */
  function parseEntries(lines) {
    var blocks = [];
    var cur = null;
    lines.forEach(function (line) {
      var m = line.match(ENTRY_HEAD_RE);
      if (m) {
        if (cur) blocks.push(cur);
        var hd = parseHead(m[1]);
        cur = { name: hd.name, keys: hd.keys, lines: [] };
        return;
      }
      /* 第一个条目之前的「关键词：」行不算任何条目的正文 */
      if (!cur) return;
      if (!cur.lines.length && !cur.keys) {
        var km = line.match(KEYLINE_RE);
        if (km) { cur.keys = km[1].trim(); return; }
      }
      cur.lines.push(line);
    });
    if (cur) blocks.push(cur);
    return blocks.map(function (b) {
      return { name: b.name, keys: b.keys, content: b.lines.join('\n') };
    });
  }

  /* 整份文件 → 书数组。有书头按书切；没有书头整包进一本无名书
     （名字由调用方用文件名兜底）。meta 的挂角色在这里只存名字，
     落库时再按角色名解析成 id —— 纯函数不碰 store。 */
  function parseBooksText(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    var books = [];
    var cur = null;      /* { name, scope, charName, lines } */
    var seenBookHead = false;

    function flush() {
      if (!cur) return;
      var book = { name: cur.name, scope: cur.scope, characterName: cur.charName, entries: parseEntries(cur.lines) };
      books.push(book);
      cur = null;
    }

    lines.forEach(function (line) {
      var bm = line.match(BOOK_HEAD_RE);
      if (bm) {
        flush();
        seenBookHead = true;
        cur = { name: parseHead(bm[1]).name, scope: 'global', charName: '', lines: [] };
        return;
      }
      if (!cur) {
        /* 没有书头：所有内容都归到那本无名书里 */
        cur = { name: '', scope: 'global', charName: '', lines: [] };
      }
      /* 书头下、第一个条目之前的元信息行 */
      if (!cur.lines.length) {
        var sm = line.match(META_SCOPE_RE);
        if (sm) {
          cur.scope = /个/.test(sm[1]) ? 'personal' : 'global';
          return;
        }
        var cm = line.match(META_CHAR_RE);
        if (cm) { cur.charName = cm[1].trim(); return; }
      }
      cur.lines.push(line);
    });
    flush();

    if (!seenBookHead && books.length === 1) books[0].headless = true;
    return books;
  }

  function nameFromFile(fileName) {
    var n = String(fileName || '').replace(/\.[^.]+$/, '');
    n = n.replace(/^sleepy[-_]?(worldbook|lorebook|世界书)[-_]?/i, '').replace(/^sleepy[-_]?/i, '');
    return n.trim() || '导入的世界书';
  }

  /* B2：酒馆格式识别。json 文件（扩展名或内容）都算。 */
  function isTavernJson(fileName, text) {
    if (/\.json$/i.test(String(fileName || ''))) return true;
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return false;
    try { JSON.parse(t); return true; } catch (e) { return false; }
  }

  /* 把解析结果落库成书。同名书覆盖（幂等）。characterName 在这里
     解析成 characterId。返回 {added, updated} */
  function importBooks(parsed) {
    var list = getBooks();
    var added = 0;
    var updated = 0;

    parsed.forEach(function (p) {
      var entries = (p.entries || []).map(function (it) {
        return {
          id: newId('e'),
          name: it.name,
          keys: it.keys,
          content: it.content,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      });
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === p.name) { hit = list[i]; break; }
      }
      if (hit) {
        hit.scope = p.scope;
        hit.characterId = p.scope === 'personal' ? charIdByName(p.characterName) : null;
        hit.entries = entries;
        hit.updatedAt = Date.now();
        updated++;
      } else {
        list.push({
          id: newId('b'),
          name: p.name,
          scope: p.scope,
          characterId: p.scope === 'personal' ? charIdByName(p.characterName) : null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          entries: entries
        });
        added++;
      }
    });

    saveBooks(list);
    return { added: added, updated: updated };
  }

  /* 条目级导入（往某本书里塞）。同名条目覆盖。返回 {added, updated} */
  function importEntries(book, items) {
    var entries = book.entries = book.entries || [];
    var added = 0;
    var updated = 0;
    items.forEach(function (it) {
      var hit = null;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === it.name) { hit = entries[i]; break; }
      }
      if (hit) {
        hit.keys = it.keys;
        hit.content = it.content;
        hit.updatedAt = Date.now();
        updated++;
      } else {
        entries.push({
          id: newId('e'),
          name: it.name,
          keys: it.keys,
          content: it.content,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        added++;
      }
    });
    return { added: added, updated: updated };
  }

  /* ==================== 页面：书列表（一级） ==================== */

  Sleepy.register('worldbook', {
    title: '世界书',
    render: function (ctx) {
      var body = ctx.body;

      var listWrap = h('div', 'contact-list');
      body.appendChild(listWrap);

      var fab = h('button', 'fab-btn', '+');
      fab.type = 'button';
      fab.title = '新建世界书';
      fab.addEventListener('click', function () {
        ctx.open('worldbook-book-edit', { id: '' });
      });
      body.appendChild(fab);

      ctx.setActions([
        { label: '导入', svg: ICON_IMPORT, onClick: function () { importBooksFile(ctx); } },
        { label: '导出', svg: ICON_EXPORT, onClick: function () { exportAllBooks(ctx); } }
      ]);

      function rebuild() {
        var list = getBooks();
        listWrap.innerHTML = '';

        if (!list.length) {
          var empty = h('div', 'contact-empty');
          empty.appendChild(h('p', 'contact-empty-text', '还没有世界书'));
          empty.appendChild(h('p', 'contact-empty-hint',
            '点右下角 + 新建一本 · 或者用右上角导入一份'));
          listWrap.appendChild(empty);
          return;
        }

        list.forEach(function (b) {
          var card = h('button', 'contact-card');
          card.type = 'button';
          card.appendChild(h('span', 'contact-av', (b.name || '?').charAt(0)));
          var main = h('div', 'contact-main');
          main.appendChild(h('div', 'contact-name', b.name || '未命名'));
          main.appendChild(h('div', 'contact-line', bookSummary(b)));
          card.appendChild(main);
          card.addEventListener('click', function () {
            ctx.open('worldbook-open', { bookId: b.id });
          });
          listWrap.appendChild(card);
        });
      }

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  function exportAllBooks(ctx) {
    var list = getBooks();
    if (!list.length) {
      ctx.toast('还没有世界书可以导出', 'warn');
      return;
    }
    var ok = downloadText('sleepy-worldbooks-' + stamp() + '.md', allBooksToText(list), 'text/markdown');
    if (ok) ctx.toast('已导出 ' + list.length + ' 本世界书', 'ok');
    else ctx.toast('导出失败：浏览器拦下了下载', 'err');
  }

  /* 一级页导入：整份文件 → 若干本书（同名书覆盖） */
  function importBooksFile(ctx) {
    pickTextFile('.txt,.md,.markdown,text/plain,text/markdown', function (text, fileName) {
      if (isTavernJson(fileName, text)) {
        ctx.toast('这是酒馆(SillyTavern)的 json 世界书，这里只收 txt / md 纯文本', 'err');
        return;
      }
      var parsed = parseBooksText(text);
      parsed = parsed.filter(function (p) {
        return (p.entries || []).length || p.name;
      });
      if (!parsed.length) {
        ctx.toast('这个文件里没有内容', 'err');
        return;
      }
      parsed.forEach(function (p, i) {
        if (!p.name) p.name = parsed.length === 1 ? nameFromFile(fileName) : ('导入的世界书 ' + (i + 1));
      });
      var res = importBooks(parsed);
      var parts = [];
      if (res.added) parts.push('新增 ' + res.added + ' 本');
      if (res.updated) parts.push('覆盖 ' + res.updated + ' 本');
      ctx.toast('导入完成：' + (parts.join('，') || '没变化'), 'ok');
      if (ctx.rebuild) ctx.rebuild();
    }, function (msg) {
      ctx.toast(msg || '读取文件失败', 'err');
    });
  }

  /* ==================== 页面：书内条目（二级） ==================== */

  Sleepy.register('worldbook-open', {
    title: '条目',
    render: function (ctx) {
      var body = ctx.body;
      var bookId = ctx.params.bookId;

      function book() { return findBook(bookId); }
      var b = book();
      if (!b) {
        ctx.toast('找不到这本世界书', 'err');
        ctx.back();
        return;
      }
      ctx.setTitle(b.name || '未命名');

      var listWrap = h('div', 'contact-list');
      body.appendChild(listWrap);

      var fab = h('button', 'fab-btn', '+');
      fab.type = 'button';
      fab.title = '新增条目';
      fab.addEventListener('click', function () {
        ctx.open('worldbook-entry-edit', { bookId: bookId, id: '' });
      });
      body.appendChild(fab);

      ctx.setActions([
        { label: '导入', svg: ICON_IMPORT, onClick: function () { importEntriesFile(ctx, bookId); } },
        { label: '导出这本', svg: ICON_EXPORT, onClick: function () { exportOneBook(ctx, bookId); } }
      ]);

      function rebuild() {
        var cur = book();
        var entries = (cur && cur.entries) || [];
        listWrap.innerHTML = '';

        if (!entries.length) {
          var empty = h('div', 'contact-empty');
          empty.appendChild(h('p', 'contact-empty-text', '这本书还没有条目'));
          empty.appendChild(h('p', 'contact-empty-hint',
            '点右下角 + 加一条 · 或者用右上角导入'));
          listWrap.appendChild(empty);
          return;
        }

        entries.forEach(function (it) {
          var card = h('button', 'contact-card' + (it.enabled === false ? ' is-off' : ''));
          card.type = 'button';
          card.appendChild(h('span', 'contact-av', it.enabled === false ? '✕' : '✓'));
          var main = h('div', 'contact-main');
          main.appendChild(h('div', 'contact-name', it.name || '未命名'));
          main.appendChild(h('div', 'contact-line', summaryOf(it)));
          card.appendChild(main);
          card.addEventListener('click', function () {
            ctx.open('worldbook-entry-edit', { bookId: bookId, id: it.id });
          });
          listWrap.appendChild(card);
        });
      }

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  function summaryOf(it) {
    var ks = splitKeys(it.keys);
    if (!ks.length) return '没设关键词 · 不会自动触发';
    var shown = ks.slice(0, 4).join('、');
    return (ks.length > 4 ? shown + ' 等 ' + ks.length + ' 个' : shown);
  }

  function exportOneBook(ctx, bookId) {
    var b = findBook(bookId);
    if (!b) return;
    if (!(b.entries || []).length) {
      ctx.toast('这本书还没有条目可以导出', 'warn');
      return;
    }
    var safe = (b.name || '世界书').replace(/[\\/:*?"<>|]/g, '_');
    var ok = downloadText(safe + '.md', bookToText(b), 'text/markdown');
    if (ok) ctx.toast('已导出「' + b.name + '」', 'ok');
    else ctx.toast('导出失败：浏览器拦下了下载', 'err');
  }

  /* 二级页导入：文件里的条目塞进当前这本书（同名条目覆盖） */
  function importEntriesFile(ctx, bookId) {
    pickTextFile('.txt,.md,.markdown,text/plain,text/markdown', function (text, fileName) {
      if (isTavernJson(fileName, text)) {
        ctx.toast('这是酒馆(SillyTavern)的 json 世界书，这里只收 txt / md 纯文本', 'err');
        return;
      }
      var parsed = parseBooksText(text);
      var items = [];
      parsed.forEach(function (p) { items = items.concat(p.entries || []); });
      items = items.filter(function (it) {
        return String(it.content || '').trim() || it.name;
      });
      if (!items.length) {
        ctx.toast('这个文件里没有条目', 'err');
        return;
      }
      var b = findBook(bookId);
      if (!b) return;
      var res = importEntries(b, items);
      saveBooks(getBooks());
      var parts = [];
      if (res.added) parts.push('新增 ' + res.added + ' 条');
      if (res.updated) parts.push('覆盖 ' + res.updated + ' 条');
      ctx.toast('导入完成：' + (parts.join('，') || '没变化'), 'ok');
      if (ctx.rebuild) ctx.rebuild();
    }, function (msg) {
      ctx.toast(msg || '读取文件失败', 'err');
    });
  }

  /* ==================== 页面：新建 / 编辑书 ==================== */

  Sleepy.register('worldbook-book-edit', {
    title: '编辑世界书',
    render: function (ctx) {
      var body = ctx.body;
      var id = ctx.params.id || '';
      var existing = id ? findBook(id) : null;

      if (id && !existing) {
        ctx.toast('找不到这本世界书', 'err');
        ctx.back();
        return;
      }
      if (!existing) ctx.setTitle('新建世界书');

      var f = {};
      var g0 = ui.group('名字', '导入导出时靠它对号入座，同名会覆盖。');
      f.name = textField({
        label: '书名',
        value: existing ? existing.name : '',
        placeholder: ''
      });
      g0.card.appendChild(f.name.el);
      body.appendChild(g0.wrap);

      /* 范围：全局 / 个人。个人 = 只在聊到挂的那个角色时才用。 */
      var g1 = ui.group('范围', '个人世界书只在聊到挂的角色时生效；全局的所有对话都带。');
      f.personal = ui.switchField({
        label: '挂在特定角色',
        hint: '关＝全局，开＝个人',
        value: existing ? existing.scope === 'personal' : false
      });
      g1.card.appendChild(f.personal.el);
      body.appendChild(g1.wrap);

      var pickedId = existing ? existing.characterId : null;
      var charRow = ui.row({
        label: '挂到谁身上',
        value: pickedId ? charName(pickedId) : '还没选',
        onClick: function () {
          Sleepy.chatSettings.openPicker(ctx, {
            title: '这本世界书挂在谁身上',
            onPick: function (pageCtx, ch) {
              pickedId = ch.id;
              ui.setRowValue(charRow, ch.name);
              if (pageCtx) pageCtx.toast('已挂在「' + ch.name + '」', 'ok');
            }
          });
        }
      });
      var charWrap = h('div');
      charWrap.appendChild(charRow);
      g1.card.appendChild(charWrap);
      function paintCharRow() { charWrap.style.display = f.personal.get() ? '' : 'none'; }
      f.personal.el.querySelector('input').addEventListener('change', paintCharRow);
      paintCharRow();

      var btnRow = h('div', 'btn-row');
      var delBtn = button('删除', 'danger');
      if (!existing) delBtn.disabled = true;
      btnRow.appendChild(delBtn);
      btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
      body.appendChild(btnRow);

      body.appendChild(h('p', 'set-foot',
        '条目在点进这本书之后的页面里加。什么时候触发、怎么拼进提示词，是 F 模块的活。'));

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      var armed = false;
      var armTimer = null;
      function resetArm() {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        armed = false;
        delBtn.textContent = '删除';
        delBtn.classList.remove('is-armed');
      }
      delBtn.addEventListener('click', function () {
        if (!existing) return;
        if (!armed) {
          armed = true;
          delBtn.textContent = '再点一次，连条目一起删';
          delBtn.classList.add('is-armed');
          armTimer = setTimeout(resetArm, 4000);
          return;
        }
        resetArm();
        saveBooks(getBooks().filter(function (x) { return x.id !== existing.id; }));
        ctx.toast('已删除', 'ok');
        ctx.back();
      });

      function doSave() {
        var name = String(f.name.get() || '').trim() || '未命名世界书';
        var personal = f.personal.get();
        if (personal && !pickedId) {
          ctx.toast('个人的世界书要先选挂到谁身上', 'warn');
          return;
        }
        var list = getBooks();
        if (existing) {
          var hit = null;
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === existing.id) { hit = list[i]; break; }
          }
          if (hit) {
            hit.name = name;
            hit.scope = personal ? 'personal' : 'global';
            hit.characterId = personal ? pickedId : null;
            hit.updatedAt = Date.now();
          }
        } else {
          list.push({
            id: newId('b'),
            name: name,
            scope: personal ? 'personal' : 'global',
            characterId: personal ? pickedId : null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            entries: []
          });
        }
        var ok = saveBooks(list);
        if (ok) {
          ctx.toast('已保存', 'ok');
          ctx.back();
        } else {
          ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
        }
      }
    }
  });

  /* ==================== 页面：新建 / 编辑条目 ==================== */

  Sleepy.register('worldbook-entry-edit', {
    title: '编辑条目',
    render: function (ctx) {
      var body = ctx.body;
      var bookId = ctx.params.bookId;
      var id = ctx.params.id || '';
      var book = findBook(bookId);
      if (!book) {
        ctx.toast('找不到这本世界书', 'err');
        ctx.back();
        return;
      }

      var existing = null;
      if (id) {
        var entries = book.entries || [];
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].id === id) { existing = entries[i]; break; }
        }
        if (!existing) {
          ctx.toast('找不到这个条目', 'err');
          ctx.back();
          return;
        }
      }
      if (!existing) ctx.setTitle('新建条目');

      var f = {};

      /* 启用开关放最上面：它是这条「现在算不算数」的总闸 */
      var g0 = ui.group('状态');
      f.enabled = ui.switchField({
        label: '启用这条',
        hint: '关掉只是暂时不用，内容还在',
        value: existing ? existing.enabled !== false : true
      });
      g0.card.appendChild(f.enabled.el);
      body.appendChild(g0.wrap);

      var g1 = ui.group('名字', '导入导出时靠它对号入座，同名会覆盖。');
      f.name = textField({
        label: '条目名',
        value: existing ? existing.name : '',
        placeholder: ''
      });
      g1.card.appendChild(f.name.el);
      body.appendChild(g1.wrap);

      var g2 = ui.group('触发关键词', '对话里提到其中任意一个，这条设定就可能被带进上下文（拼接是 F 模块的活）。');
      f.keys = textField({
        label: '关键词',
        value: existing ? existing.keys : '',
        placeholder: '',
        hint: '多个关键词用逗号或顿号隔开'
      });
      g2.card.appendChild(f.keys.el);
      body.appendChild(g2.wrap);

      var g3 = ui.group('正文', '原样存、原样导出，不解析 —— 带什么格式都行。');
      f.content = textArea({
        label: '内容',
        value: existing ? existing.content : '',
        rows: 12,
        counter: true,
        placeholder: ''
      });
      g3.card.appendChild(f.content.el);
      body.appendChild(g3.wrap);

      var btnRow = h('div', 'btn-row');
      var delBtn = button('删除', 'danger');
      if (!existing) delBtn.disabled = true;
      btnRow.appendChild(delBtn);
      btnRow.appendChild(button('导出这条', 'ghost', function () { doExportOne(); }));
      btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
      body.appendChild(btnRow);

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      var armed = false;
      var armTimer = null;
      function resetArm() {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        armed = false;
        delBtn.textContent = '删除';
        delBtn.classList.remove('is-armed');
      }
      delBtn.addEventListener('click', function () {
        if (!existing) return;
        if (!armed) {
          armed = true;
          delBtn.textContent = '再点一次，确认删除';
          delBtn.classList.add('is-armed');
          armTimer = setTimeout(resetArm, 4000);
          return;
        }
        resetArm();
        book.entries = (book.entries || []).filter(function (x) { return x.id !== existing.id; });
        saveBooks(getBooks());
        ctx.toast('已删除', 'ok');
        ctx.back();
      });

      function collect() {
        return {
          name: String(f.name.get() || '').trim() || '未命名条目',
          keys: String(f.keys.get() || '').trim(),
          content: f.content.get(),
          enabled: f.enabled.get()
        };
      }

      function doSave() {
        var next = collect();
        var entries = book.entries = book.entries || [];
        if (existing) {
          existing.name = next.name;
          existing.keys = next.keys;
          existing.content = next.content;
          existing.enabled = next.enabled;
          existing.updatedAt = Date.now();
        } else {
          entries.push({
            id: newId('e'),
            name: next.name,
            keys: next.keys,
            content: next.content,
            enabled: next.enabled,
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        }
        book.updatedAt = Date.now();
        var ok = saveBooks(getBooks());
        if (ok) {
          ctx.toast('已保存', 'ok');
          ctx.back();
        } else {
          ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
        }
      }

      function doExportOne() {
        var one = collect();
        if (!String(one.content).trim()) {
          ctx.toast('正文是空的，先写点东西', 'warn');
          return;
        }
        var safe = one.name.replace(/[\\/:*?"<>|]/g, '_');
        var ok = downloadText(safe + '.md',
          entryHead({ name: one.name, keys: one.keys }) + '\n' + one.content + '\n',
          'text/markdown');
        if (ok) ctx.toast('已导出「' + one.name + '」', 'ok');
        else ctx.toast('导出失败：浏览器拦下了下载', 'err');
      }
    }
  });

  /* ---------------------------- 对外 ---------------------------- */

  /* 只暴露纯函数，F 模块召回要用 splitKeys / 遍历书。不暴露 UI。 */
  Sleepy.worldbook = {
    getBooks: getBooks,
    splitKeys: splitKeys,
    charName: charName,
    bookToText: bookToText,
    allBooksToText: allBooksToText,
    parseBooksText: parseBooksText,
    importBooks: importBooks,
    isTavernJson: isTavernJson
  };

})(window);
