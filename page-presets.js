/* ============================================================
   page-presets.js — 人设预设库（施工卡 A5）
   依赖：store.js、ui.js、app.js
   页面：settings-presets（列表）→ settings-preset-edit（编辑）

   对应验收：能新建、编辑保存、删除；导出的 txt/md 能再导入回来且内容一致。

   存储：store 的 presets: [{ id, name, content, createdAt, updatedAt }]

   ---- 文件格式（导出 / 导入）----
   纯文本，不碰 json（施工卡明确禁 json）。多个人设用带「预设：」的分隔头分开：

     ===== 预设：阿岚 =====
     （正文原样，可以是多行）
     ===== 预设：小雨 =====
     （正文）

   没有分隔头的文件会被当成「一个预设」，名字取文件名。
   导出是 `头 + '\n' + 正文 + '\n'`，解析时按 '\n' 切开后把这些分隔换行
   正好吃掉，所以导进导出内容一致（含正文末尾的空行）。
   同一个名字再次导入＝覆盖，而不是又加一份 —— 这样重复导入同一个文件是幂等的。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var textField = ui.textField;
  var textArea = ui.textArea;
  var button = ui.button;
  var downloadText = ui.downloadText;
  var pickTextFile = ui.pickTextFile;

  /* 分隔头。宽松一点：等号三个以上、冒号中英文都认 */
  var HEAD_RE = /^={3,}\s*预设\s*[：:]\s*(.+?)\s*={3,}$/;

  /* ---------------------------- 数据 ---------------------------- */

  function getPresets() {
    var list = store.get('presets');
    return Array.isArray(list) ? list : [];
  }

  /* 必须把 store.set 的结果返回出去！
     漏了 return 的话调用方拿到 undefined，`if (ok)` 永远走失败分支 ——
     表现是「数据其实存进去了，但页面弹保存失败、还不关页面」，
     因为 store 是「先写内存缓存再落盘」，缓存里有值所以看起来像成功了。 */
  function savePresets(list) { return store.set('presets', list); }

  function newId() {
    return 'ps' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function findPreset(id) {
    var list = getPresets();
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

  /* ------------------------- 导出 / 解析 ------------------------- */

  function toFileText(items) {
    var out = '';
    items.forEach(function (it) {
      out += '===== 预设：' + it.name + ' =====\n' + (it.content || '') + '\n';
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

    /* 没有分隔头 → 整篇当一个预设，命名交给调用方用文件名兜底 */
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
    n = n.replace(/^sleepy[-_]?/i, '');
    return n.trim() || '导入的预设';
  }

  function isJsonish(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return false;
    try { JSON.parse(t); return true; } catch (e) { return false; }
  }

  /* 导入：同名覆盖，新名新增。返回 {added, updated} */
  function importItems(items) {
    var list = getPresets();
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

    savePresets(list);
    return { added: added, updated: updated };
  }

  /* ==================== 页面：预设列表 ==================== */

  Sleepy.register('settings-presets', {
    title: '人设预设库',
    render: function (ctx) {
      var body = ctx.body;

      var g = group('预设', '「贴人设」用的底稿。选中哪一份，以后由 F 模块拼进系统提示词。');
      var listCard = g.card;

      function rebuild() {
        listCard.innerHTML = '';
        var list = getPresets();

        if (!list.length) {
          listCard.appendChild(row({ label: '还没有任何预设', plain: true }));
        } else {
          list.forEach(function (it) {
            listCard.appendChild(row({
              label: it.name,
              hint: (it.content || '').length + ' 字',
              onClick: function () { ctx.open('settings-preset-edit', { id: it.id }); }
            }));
          });
        }

        listCard.appendChild(row({
          label: '新建预设',
          hint: '从空白开始写',
          onClick: function () { ctx.open('settings-preset-edit', { id: '' }); }
        }));
      }

      body.appendChild(g.wrap);

      var g2 = group('导入导出', 'txt / md 纯文本。分隔头是「===== 预设：名字 =====」，' +
        '没有分隔头的文件会被当成一个预设。');
      g2.card.appendChild(row({
        label: '导出全部',
        hint: '所有预设合并成一个文件',
        onClick: function () { exportAll(ctx); }
      }));
      g2.card.appendChild(row({
        label: '导入文件',
        hint: '同名覆盖，新名新增',
        onClick: function () { importFile(ctx); }
      }));
      body.appendChild(g2.wrap);

      body.appendChild(h('p', 'set-foot',
        '只收 .txt / .md。json 一律拒收 —— 那是外部角色卡格式，不是这里的存档。'));

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  function exportAll(ctx) {
    var list = getPresets();
    if (!list.length) {
      ctx.toast('还没有预设可以导出', 'warn');
      return;
    }
    var ok = downloadText('sleepy-presets-' + stamp() + '.md', toFileText(list), 'text/markdown');
    if (ok) ctx.toast('已导出 ' + list.length + ' 个预设', 'ok');
    else ctx.toast('导出失败：浏览器拦下了下载', 'err');
  }

  function importFile(ctx) {
    pickTextFile('.txt,.md,.markdown,text/plain,text/markdown', function (text, fileName) {
      if (/\.json$/i.test(fileName) || isJsonish(text)) {
        ctx.toast('这是 json 格式，预设只收 txt / md 纯文本', 'err');
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
        if (!it.name) it.name = items.length === 1 ? nameFromFile(fileName) : ('导入的预设 ' + (i + 1));
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

  /* ==================== 页面：编辑预设 ==================== */

  Sleepy.register('settings-preset-edit', {
    title: '编辑预设',
    render: function (ctx) {
      var body = ctx.body;
      var id = ctx.params.id || '';
      var existing = id ? findPreset(id) : null;

      if (id && !existing) {
        ctx.toast('找不到这个预设', 'err');
        ctx.back();
        return;
      }
      if (!existing) ctx.setTitle('新建预设');

      var f = {};
      var g = group('名字');
      f.name = textField({
        label: '预设名',
        value: existing ? existing.name : '',
        placeholder: '例如 阿岚 / 冷淡系',
        hint: '导入导出时用这个名字对号入座，同名会覆盖'
      });
      g.card.appendChild(f.name.el);
      body.appendChild(g.wrap);

      var g2 = group('人设正文', '原样存、原样导出，不解析 —— 带什么格式都行。');
      f.content = textArea({
        label: '正文',
        value: existing ? existing.content : '',
        rows: 14,
        counter: true,
        placeholder: '她是谁、怎么说话、在意什么、不会做什么……'
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
        '预设只是一份底稿。真正怎么用它拼系统提示词，是 F 模块（提示词引擎）的事。'));

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      /* 删除用「再点一次确认」，和「清除全部数据」保持同一套手感。
         原生 confirm() 在手机上很难看，也毁沉浸感。 */
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
        savePresets(getPresets().filter(function (x) { return x.id !== existing.id; }));
        ctx.toast('已删除', 'ok');
        ctx.back();
      });

      function collect() {
        return {
          name: String(f.name.get() || '').trim() || '未命名预设',
          content: f.content.get()
        };
      }

      function doSave() {
        var next = collect();
        var list = getPresets();

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

        var ok = savePresets(list);
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
  Sleepy.presets = {
    toFileText: toFileText,
    parseFileText: parseFileText,
    importItems: importItems
  };

})(window);
