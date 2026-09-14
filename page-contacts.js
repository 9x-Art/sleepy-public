/* ============================================================
   page-contacts.js — 名片夹（角色）
   依赖：store.js、ui.js、app.js
   页面：contacts（角色列表）→ contact-edit（新建 / 编辑）

   为什么从「设置 → 人设预设库」搬到名片夹：
     预设库存的是「这个角色是谁」，它本来就是个「新增角色」，
     跟设置里的接口 / 外观 / 备份不是一类东西。应用里既然有
     名片夹这个 App，角色就该住在里面。

   导入导出放在右上角（两个图标），不占列表的行：
     它们是低频动作，不该跟「哪个角色」抢视线。

   存储：store 的 characters: [{ id, name, content, createdAt, updatedAt }]
     旧键 presets（A5 时期）由 store.js 在启动时自动搬过来，老存档不会丢。

   ---- 文件格式（导出 / 导入）----
   纯文本，不碰 json。多个角色用带「角色：」的分隔头分开：

     ===== 角色：阿岚 =====
     （正文原样，可以是多行）

   兼容更老的「===== 预设：名字 =====」头，老文件照样能导进来。
   没有分隔头的文件会被当成一个角色，名字取文件名。
   导出是 `头 + '\n' + 正文 + '\n'`，解析时按 '\n' 切开后把这些分隔换行
   正好吃掉，所以导进导出内容一致（含正文末尾的空行）。
   同一个名字再次导入＝覆盖，而不是又加一份 —— 重复导入同一个文件是幂等的。
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

  /* 分隔头。宽松一点：等号三个以上、冒号中英文都认。
     「预设」是 A5 时期的旧头，留着向后兼容。 */
  var HEAD_RE = /^={3,}\s*(?:角色|预设)\s*[：:]\s*(.+?)\s*={3,}$/;

  /* 右上角的两个图标。项目里所有图标都是内联 SVG，
     这里也走同一套（不依赖字体，不依赖网络）。
     一律 currentColor，这样按钮状态一变它自己跟着变。 */
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

  function getChars() {
    var list = store.get('characters');
    return Array.isArray(list) ? list : [];
  }

  /* 必须把 store.set 的结果返回出去！
     漏了 return 的话调用方拿到 undefined，`if (ok)` 永远走失败分支 ——
     表现是「数据其实存进去了，但页面弹保存失败、还不关页面」，
     因为 store 是「先写内存缓存再落盘」，缓存里有值所以看起来像成功了。 */
  function saveChars(list) { return store.set('characters', list); }

  function newId() {
    return 'ch' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function findChar(id) {
    var list = getChars();
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

  /* 名片上的头像圈：取名字第一个字。
     英文名大写，中文直接取首字。没名字给个问号兜底。 */
  function initialOf(name) {
    var s = String(name || '').trim();
    if (!s) return '?';
    return s.charAt(0).toUpperCase();
  }

  /* 名片上的那一行小字：正文第一行非空的内容 */
  function summaryOf(it) {
    var lines = String(it.content || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) continue;
      return t.length > 42 ? t.slice(0, 42) + '…' : t;
    }
    return '还没写人设正文';
  }

  /* ------------------------- 导出 / 解析 ------------------------- */

  function toFileText(items) {
    var out = '';
    items.forEach(function (it) {
      out += '===== 角色：' + it.name + ' =====\n' + (it.content || '') + '\n';
    });
    return out;
  }

  function parseFileText(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    /* 文件末尾那个换行切出来的空串不算内容 */
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    var blocks = [];
    var cur = null;
    lines.forEach(function (line) {
      var m = line.match(HEAD_RE);
      if (m) {
        if (cur) blocks.push(cur);
        cur = { name: m[1], lines: [] };
        return;
      }
      if (cur) cur.lines.push(line);
    });
    if (cur) blocks.push(cur);

    /* 没有分隔头 → 整篇当一个角色，命名交给调用方用文件名兜底 */
    if (!blocks.length) {
      return [{ name: '', content: String(text || '').replace(/\n$/, '') }];
    }
    return blocks.map(function (b) {
      return { name: b.name.trim(), content: b.lines.join('\n') };
    });
  }

  /* 文件名兜底：去掉扩展名，再把常见的导出前缀去掉 */
  function nameFromFile(fileName) {
    var n = String(fileName || '').replace(/\.[^.]+$/, '');
    n = n.replace(/^sleepy[-_]?(contacts?|presets?)[-_]?/i, '').replace(/^sleepy[-_]?/i, '');
    return n.trim() || '导入的角色';
  }

  function isJsonish(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return false;
    try { JSON.parse(t); return true; } catch (e) { return false; }
  }

  /* 导入：同名覆盖，新名新增。返回 {added, updated} */
  function importItems(items) {
    var list = getChars();
    var added = 0;
    var updated = 0;

    items.forEach(function (it) {
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === it.name) { hit = list[i]; break; }
      }
      if (hit) {
        hit.content = it.content;
        hit.updatedAt = Date.now();
        updated++;
      } else {
        list.push({
          id: newId(),
          name: it.name,
          content: it.content,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        added++;
      }
    });

    saveChars(list);
    return { added: added, updated: updated };
  }

  /* ==================== 页面：角色列表 ==================== */

  Sleepy.register('contacts', {
    title: '名片夹',
    render: function (ctx) {
      var body = ctx.body;

      var listWrap = h('div', 'contact-list');
      body.appendChild(listWrap);

      var fab = h('button', 'fab-btn', '+');
      fab.type = 'button';
      fab.title = '新增角色';
      fab.addEventListener('click', function () {
        ctx.open('contact-edit', { id: '' });
      });
      body.appendChild(fab);

      /* 导入导出是低频动作，收到右上角。它们是两个图标，
         不是列表里的两行 —— 列表只应该出现「角色」。 */
      ctx.setActions([
        { label: '导入', svg: ICON_IMPORT, onClick: function () { importFile(ctx); } },
        { label: '导出', svg: ICON_EXPORT, onClick: function () { exportAll(ctx); } }
      ]);

      function rebuild() {
        var list = getChars();
        listWrap.innerHTML = '';

        if (!list.length) {
          var empty = h('div', 'contact-empty');
          empty.appendChild(h('p', 'contact-empty-text', '还没有角色'));
          empty.appendChild(h('p', 'contact-empty-hint',
            '点右下角 + 建一个 · 或者用右上角导入一份人设'));
          listWrap.appendChild(empty);
          return;
        }

        list.forEach(function (it) {
          var card = h('button', 'contact-card');
          card.type = 'button';

          card.appendChild(h('span', 'contact-av', initialOf(it.name)));

          var main = h('div', 'contact-main');
          main.appendChild(h('div', 'contact-name', it.name || '未命名'));
          main.appendChild(h('div', 'contact-line', summaryOf(it)));
          card.appendChild(main);

          card.addEventListener('click', function () {
            ctx.open('contact-edit', { id: it.id });
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
    var list = getChars();
    if (!list.length) {
      ctx.toast('还没有角色可以导出', 'warn');
      return;
    }
    var ok = downloadText('sleepy-contacts-' + stamp() + '.md', toFileText(list), 'text/markdown');
    if (ok) ctx.toast('已导出 ' + list.length + ' 个角色', 'ok');
    else ctx.toast('导出失败：浏览器拦下了下载', 'err');
  }

  function importFile(ctx) {
    pickTextFile('.txt,.md,.markdown,text/plain,text/markdown', function (text, fileName) {
      if (/\.json$/i.test(fileName) || isJsonish(text)) {
        ctx.toast('这是 json 格式，名片夹只收 txt / md 纯文本', 'err');
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
        if (!it.name) it.name = items.length === 1 ? nameFromFile(fileName) : ('导入的角色 ' + (i + 1));
      });

      var res = importItems(items);
      var parts = [];
      if (res.added) parts.push('新增 ' + res.added + ' 个');
      if (res.updated) parts.push('覆盖 ' + res.updated + ' 个');
      ctx.toast('导入完成：' + (parts.join('，') || '没变化'), 'ok');
      if (ctx.rebuild) ctx.rebuild();
    }, function (msg) {
      ctx.toast(msg || '读取文件失败', 'err');
    });
  }

  /* ==================== 页面：新建 / 编辑角色 ==================== */

  Sleepy.register('contact-edit', {
    title: '编辑角色',
    render: function (ctx) {
      var body = ctx.body;
      var id = ctx.params.id || '';
      var existing = id ? findChar(id) : null;

      if (id && !existing) {
        ctx.toast('找不到这个角色', 'err');
        ctx.back();
        return;
      }
      if (!existing) ctx.setTitle('新建角色');

      var f = {};
      var g = ui.group('名字', '导入导出时靠它对号入座，同名会覆盖。');
      f.name = textField({
        label: '角色名',
        value: existing ? existing.name : '',
        placeholder: '例如 阿岚 / 冷淡系',
        hint: '聊天记录里出现的名字就是它'
      });
      g.card.appendChild(f.name.el);
      body.appendChild(g.wrap);

      var g2 = ui.group('人设正文', '原样存、原样导出，不解析 —— 带什么格式都行。');
      f.content = textArea({
        label: '正文',
        value: existing ? existing.content : '',
        rows: 14,
        counter: true,
        /* 这里不能写「她」：通用角色扮演，角色可能是任何性别甚至不是人 */
        placeholder: '叫什么、怎么说话、在意什么、不会做什么……'
      });
      g2.card.appendChild(f.content.el);
      body.appendChild(g2.wrap);

      var btnRow = h('div', 'btn-row');
      /* 删除按钮的点击不在这里挂 —— 下面有「再点一次确认」那套，
         两处都挂会一次点击触发两次逻辑（以前就漏了个 doDelete 引用） */
      var delBtn = button('删除', 'danger');
      if (!existing) delBtn.disabled = true;
      btnRow.appendChild(delBtn);
      btnRow.appendChild(button('导出这个', 'ghost', function () { doExportOne(); }));
      btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
      body.appendChild(btnRow);

      body.appendChild(h('p', 'set-foot',
        '角色只是一份底稿。真正怎么把它拼进系统提示词，是 F 模块（提示词引擎）的事。'));

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      /* 删除用「再点一次确认」，和「清除全部数据」保持同一套手感 */
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
        saveChars(getChars().filter(function (x) { return x.id !== existing.id; }));
        ctx.toast('已删除', 'ok');
        ctx.back();
      });

      function collect() {
        return {
          name: String(f.name.get() || '').trim() || '未命名角色',
          content: f.content.get()
        };
      }

      function doSave() {
        var next = collect();
        var list = getChars();

        if (existing) {
          var hit = null;
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === existing.id) { hit = list[i]; break; }
          }
          if (hit) {
            hit.name = next.name;
            hit.content = next.content;
            hit.updatedAt = Date.now();
          }
        } else {
          list.push({
            id: newId(),
            name: next.name,
            content: next.content,
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        }

        var ok = saveChars(list);
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
        var ok = downloadText(safe + '.md', one.content, 'text/markdown');
        if (ok) ctx.toast('已导出「' + one.name + '」', 'ok');
        else ctx.toast('导出失败：浏览器拦下了下载', 'err');
      }
    }
  });

  /* ---------------------------- 对外 ---------------------------- */

  /* 只暴露纯函数。理由有两个：
     1) 导出/导入的格式逻辑是纯文本进出，没有副作用，单独测最省事
        （文件下载和文件选择在自动化里很难真的走一遍）；
     2) B 模块做世界书导入时，大概率也要复用同一套「纯文本 + 分隔头」的思路。
     不暴露任何 UI 或数据状态。 */
  Sleepy.characters = {
    toFileText: toFileText,
    parseFileText: parseFileText,
    importItems: importItems,
    /* 显示用的两个小工具：聊天列表的「挑个人来聊」浮层也要画名片，
       一份逻辑两处用，免得两边长相跑偏 */
    initialOf: initialOf,
    summaryOf: summaryOf
  };

})(window);
