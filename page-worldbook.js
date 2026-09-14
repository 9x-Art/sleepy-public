/* ============================================================
   page-worldbook.js — 世界书（模块 B）
   依赖：store.js、ui.js、app.js
   页面：worldbook（条目列表）→ worldbook-edit（新建 / 编辑）
   入口：设置 → 模型与对话 → 世界书

   世界书是什么：一堆「带触发关键词的设定条目」。聊天里提到
   关键词，F 模块（提示词引擎）就把对应条目的正文拼进上下文。
   这里只负责「存」和「管」，拼装是 F 的活。

   ---- 文件格式（导出 / 导入，B1）----
   纯文本，不碰 json。一个条目一个分隔头，关键词写在头里：

     ===== 条目：青岚镇 | 关键词：青岚镇，北门，渡口 =====
     （正文原样，多行）

   兼容写法：头里不带关键词、但正文第一行是「关键词：…」的，
   也认（那一行会被吃掉，不进正文）。
   没有分隔头的文件 → 整篇当一个条目，名字取文件名，关键词留空
   （空关键词的条目不会自动触发，编辑页里会提醒）。

   ---- 酒馆格式拒收（B2）----
   酒馆(SillyTavern)的世界书是带 entries 字段的 json —— 一律
   识别出来给明确提示，不静默失败也不当纯文本硬吃。
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

  /* 分隔头：===== 条目：xxx ===== 或 ===== 世界书：xxx =====
     等号三个以上，冒号中英文都认。名字后面可以用 | 或 ｜ 跟一段关键词。 */
  var HEAD_RE = /^={3,}\s*(?:条目|世界书)\s*[：:]\s*(.+?)\s*={3,}$/;
  var KEYLINE_RE = /^(?:关键词|触发词|keys)\s*[：:]\s*(.+)$/i;

  /* 右上角图标，和名片夹同一套线性 SVG（currentColor 跟主题走） */
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

  function getEntries() {
    var list = store.get('worldbook');
    return Array.isArray(list) ? list : [];
  }

  /* return 不能漏 —— store 先写内存缓存再落盘，漏了 return 会出现
     「其实存进去了但页面弹保存失败」（名片夹那次踩过） */
  function saveEntries(list) { return store.set('worldbook', list); }

  function newId() {
    return 'wb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function findEntry(id) {
    var list = getEntries();
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

  /* 关键词字符串 ↔ 数组。中英文逗号、顿号、分号都当分隔符，
     空白项丢掉。存的时候统一存成原始字符串，切分只在召回时做。 */
  function splitKeys(s) {
    return String(s || '').split(/[,，、;；]+/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
  }

  function summaryOf(it) {
    var ks = splitKeys(it.keys);
    if (!ks.length) return '没设关键词 · 不会自动触发';
    var shown = ks.slice(0, 4).join('、');
    return (ks.length > 4 ? shown + ' 等 ' + ks.length + ' 个' : shown);
  }

  /* ------------------------- 导出 / 解析 ------------------------- */

  function toFileText(items) {
    var out = '';
    items.forEach(function (it) {
      var ks = splitKeys(it.keys).join('，');
      var head = '===== 条目：' + (it.name || '未命名') +
                 (ks ? ' | 关键词：' + ks : '') + ' =====';
      out += head + '\n' + (it.content || '') + '\n';
    });
    return out;
  }

  /* 头里的「名字 | 关键词：a，b」拆开。返回 { name, keys } */
  function parseHead(rest) {
    var name = rest;
    var keys = '';
    var bar = rest.split('|');
    if (bar.length > 1) {
      name = bar[0];
      for (var i = 1; i < bar.length; i++) {
        var m = bar[i].match(/^\s*(?:关键词|触发词|keys)\s*[：:]\s*(.+)$/i);
        if (m) keys = m[1];
      }
    }
    return { name: String(name).trim(), keys: keys.trim() };
  }

  function parseFileText(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    var blocks = [];
    var cur = null;
    lines.forEach(function (line) {
      var m = line.match(HEAD_RE);
      if (m) {
        if (cur) blocks.push(cur);
        var hd = parseHead(m[1]);
        cur = { name: hd.name, keys: hd.keys, lines: [] };
        return;
      }
      /* 正文第一行的「关键词：…」也认（兼容另一种写法），吃掉不进正文 */
      if (cur && !cur.lines.length && !cur.keys) {
        var km = line.match(KEYLINE_RE);
        if (km) { cur.keys = km[1].trim(); return; }
      }
      if (cur) cur.lines.push(line);
    });
    if (cur) blocks.push(cur);

    /* 没有分隔头 → 整篇一个条目，名字交给调用方用文件名兜底 */
    if (!blocks.length) {
      return [{ name: '', keys: '', content: String(text || '').replace(/\n$/, '') }];
    }
    return blocks.map(function (b) {
      return { name: b.name, keys: b.keys, content: b.lines.join('\n') };
    });
  }

  function nameFromFile(fileName) {
    var n = String(fileName || '').replace(/\.[^.]+$/, '');
    n = n.replace(/^sleepy[-_]?(worldbook|lorebook|世界书)[-_]?/i, '').replace(/^sleepy[-_]?/i, '');
    return n.trim() || '导入的条目';
  }

  /* B2：酒馆格式识别。json 文件（扩展名或内容）都算 ——
     酒馆世界书就是 json，没有例外情况需要放行。 */
  function isTavernJson(fileName, text) {
    if (/\.json$/i.test(String(fileName || ''))) return true;
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return false;
    try { JSON.parse(t); return true; } catch (e) { return false; }
  }

  /* 导入：同名（条目名）覆盖，新名新增。返回 {added, updated} */
  function importItems(items) {
    var list = getEntries();
    var added = 0;
    var updated = 0;

    items.forEach(function (it) {
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === it.name) { hit = list[i]; break; }
      }
      if (hit) {
        hit.keys = it.keys;
        hit.content = it.content;
        hit.updatedAt = Date.now();
        updated++;
      } else {
        list.push({
          id: newId(),
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

    saveEntries(list);
    return { added: added, updated: updated };
  }

  /* ==================== 页面：条目列表 ==================== */

  Sleepy.register('worldbook', {
    title: '世界书',
    render: function (ctx) {
      var body = ctx.body;

      var listWrap = h('div', 'contact-list');
      body.appendChild(listWrap);

      var fab = h('button', 'fab-btn', '+');
      fab.type = 'button';
      fab.title = '新增条目';
      fab.addEventListener('click', function () {
        ctx.open('worldbook-edit', { id: '' });
      });
      body.appendChild(fab);

      ctx.setActions([
        { label: '导入', svg: ICON_IMPORT, onClick: function () { importFile(ctx); } },
        { label: '导出', svg: ICON_EXPORT, onClick: function () { exportAll(ctx); } }
      ]);

      function rebuild() {
        var list = getEntries();
        listWrap.innerHTML = '';

        if (!list.length) {
          var empty = h('div', 'contact-empty');
          empty.appendChild(h('p', 'contact-empty-text', '还没有条目'));
          empty.appendChild(h('p', 'contact-empty-hint',
            '点右下角 + 建一个 · 或者用右上角导入一份世界书'));
          listWrap.appendChild(empty);
          return;
        }

        list.forEach(function (it) {
          var card = h('button', 'contact-card' + (it.enabled === false ? ' is-off' : ''));
          card.type = 'button';

          card.appendChild(h('span', 'contact-av', it.enabled === false ? '✕' : '✓'));

          var main = h('div', 'contact-main');
          main.appendChild(h('div', 'contact-name', it.name || '未命名'));
          main.appendChild(h('div', 'contact-line', summaryOf(it)));
          card.appendChild(main);

          card.addEventListener('click', function () {
            ctx.open('worldbook-edit', { id: it.id });
          });
          listWrap.appendChild(card);
        });
      }

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  function exportAll(ctx) {
    var list = getEntries();
    if (!list.length) {
      ctx.toast('还没有条目可以导出', 'warn');
      return;
    }
    var ok = downloadText('sleepy-worldbook-' + stamp() + '.md', toFileText(list), 'text/markdown');
    if (ok) ctx.toast('已导出 ' + list.length + ' 个条目', 'ok');
    else ctx.toast('导出失败：浏览器拦下了下载', 'err');
  }

  function importFile(ctx) {
    pickTextFile('.txt,.md,.markdown,text/plain,text/markdown', function (text, fileName) {
      /* B2：酒馆格式 → 明确提示，不静默失败 */
      if (isTavernJson(fileName, text)) {
        ctx.toast('这是酒馆(SillyTavern)的 json 世界书，这里只收 txt / md 纯文本', 'err');
        return;
      }
      var items = parseFileText(text);
      items = items.filter(function (it) {
        return String(it.content || '').trim() || it.name;
      });
      if (!items.length) {
        ctx.toast('这个文件里没有内容', 'err');
        return;
      }
      items.forEach(function (it, i) {
        if (!it.name) it.name = items.length === 1 ? nameFromFile(fileName) : ('导入的条目 ' + (i + 1));
      });

      var res = importItems(items);
      var parts = [];
      if (res.added) parts.push('新增 ' + res.added + ' 条');
      if (res.updated) parts.push('覆盖 ' + res.updated + ' 条');
      ctx.toast('导入完成：' + (parts.join('，') || '没变化'), 'ok');
      if (ctx.rebuild) ctx.rebuild();
    }, function (msg) {
      ctx.toast(msg || '读取文件失败', 'err');
    });
  }

  /* ==================== 页面：新建 / 编辑条目 ==================== */

  Sleepy.register('worldbook-edit', {
    title: '编辑条目',
    render: function (ctx) {
      var body = ctx.body;
      var id = ctx.params.id || '';
      var existing = id ? findEntry(id) : null;

      if (id && !existing) {
        ctx.toast('找不到这个条目', 'err');
        ctx.back();
        return;
      }
      if (!existing) ctx.setTitle('新建条目');

      var f = {};
      var g = ui.group('条目名', '导入导出时靠它对号入座，同名会覆盖。');
      f.name = textField({
        label: '条目名',
        value: existing ? existing.name : '',
        placeholder: '',
        hint: '比如：青岚镇 · 江家大宅'
      });
      g.card.appendChild(f.name.el);
      body.appendChild(g.wrap);

      var g2 = ui.group('触发关键词', '对话里提到其中任意一个，这条设定就可能被带进上下文（拼接是 F 模块的活）。');
      f.keys = textField({
        label: '关键词',
        value: existing ? existing.keys : '',
        placeholder: '',
        hint: '用逗号、顿号隔开，比如：青岚镇，北门，渡口'
      });
      g2.card.appendChild(f.keys.el);
      body.appendChild(g2.wrap);

      var g3 = ui.group('正文', '原样存、原样导出，不解析 —— 带什么格式都行。');
      f.content = textArea({
        label: '内容',
        value: existing ? existing.content : '',
        rows: 12,
        counter: true,
        placeholder: '这个地方的规矩、住着谁、发生过什么……'
      });
      g3.card.appendChild(f.content.el);
      body.appendChild(g3.wrap);

      /* 启用开关：关掉的条目整卡压暗，不会进 F 模块的召回池 */
      f.enabled = ui.switchField({
        label: '启用这条',
        hint: '关掉只是暂时不用，内容还在',
        value: existing ? existing.enabled !== false : true
      });
      var g4 = ui.group('状态');
      g4.card.appendChild(f.enabled.el);
      body.appendChild(g4.wrap);

      var btnRow = h('div', 'btn-row');
      var delBtn = button('删除', 'danger');
      if (!existing) delBtn.disabled = true;
      btnRow.appendChild(delBtn);
      btnRow.appendChild(button('导出这条', 'ghost', function () { doExportOne(); }));
      btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
      body.appendChild(btnRow);

      body.appendChild(h('p', 'set-foot',
        '世界书只是资料库。什么时候触发、怎么拼进提示词，是 F 模块（提示词引擎）的事。'));

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      /* 「再点一次确认」删除，和名片夹同一套手感 */
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
        saveEntries(getEntries().filter(function (x) { return x.id !== existing.id; }));
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
        var list = getEntries();

        if (existing) {
          var hit = null;
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === existing.id) { hit = list[i]; break; }
          }
          if (hit) {
            hit.name = next.name;
            hit.keys = next.keys;
            hit.content = next.content;
            hit.enabled = next.enabled;
            hit.updatedAt = Date.now();
          }
        } else {
          list.push({
            id: newId(),
            name: next.name,
            keys: next.keys,
            content: next.content,
            enabled: next.enabled,
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        }

        var ok = saveEntries(list);
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
        var ok = downloadText(safe + '.md', toFileText([{
          name: one.name, keys: one.keys, content: one.content
        }]), 'text/markdown');
        if (ok) ctx.toast('已导出「' + one.name + '」', 'ok');
        else ctx.toast('导出失败：浏览器拦下了下载', 'err');
      }
    }
  });

  /* ---------------------------- 对外 ---------------------------- */

  /* 只暴露纯函数（splitKeys 召回时 F 模块要用），
     不暴露任何 UI 或数据状态 —— 理由同名片夹。 */
  Sleepy.worldbook = {
    toFileText: toFileText,
    parseFileText: parseFileText,
    importItems: importItems,
    splitKeys: splitKeys,
    isTavernJson: isTavernJson
  };

})(window);
