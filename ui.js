/* ============================================================
   ui.js — 通用 UI 组件层
   依赖：无
   被依赖：所有 page-*.js（必须排在它们之前加载，见 index.html）

   为什么要单独一层：设置、备份、以后的聊天页都要「分组卡片 /
   列表行 / 输入框 / 开关 / 按钮」。复制三份就是屎山的起点。
   这一层只做无状态 DOM 构造：不读 store、不发请求、不认识任何
   业务字段。页面调用它，它不认识页面。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* ---------------------------- 基础 ---------------------------- */

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  /* 分组卡片：铅笔字标题 + 纸卡片 + 可选脚注 */
  function group(title, note) {
    var wrap = h('div', 'set-group');
    if (title) wrap.appendChild(h('p', 'set-group-title', title));
    var card = h('div', 'set-card');
    wrap.appendChild(card);
    if (note) wrap.appendChild(h('p', 'set-group-note', note));
    return { wrap: wrap, card: card };
  }

  /* 列表行。没有 onClick 就是「还没贴好」的灰行 */
  function row(o) {
    var r = h('button', 'set-row');
    r.type = 'button';
    var main = h('span', 'set-row-main');
    main.appendChild(h('span', 'set-row-label', o.label));
    if (o.hint) main.appendChild(h('span', 'set-row-hint', o.hint));
    r.appendChild(main);

    var right = h('span', 'set-row-right');
    if (o.value) right.appendChild(h('span', 'set-row-value', o.value));
    if (o.badge) right.appendChild(h('span', 'set-badge set-badge-' + (o.badgeKind || 'dim'), o.badge));
    if (o.onClick) right.appendChild(h('span', 'set-row-arrow', '›'));
    r.appendChild(right);

    if (o.onClick) r.addEventListener('click', o.onClick);
    /* plain：只读信息行。不是「还没贴好」，所以不置灰、不给箭头 */
    else if (o.plain) { r.disabled = true; r.classList.add('is-plain'); }
    else { r.disabled = true; r.classList.add('is-soon'); }
    return r;
  }

  /* 只改一行的右侧值，不重建整行。
     从下级页返回时靠它刷新「已配置 / 未配置」「存档体积」，
     这样列表的滚动位置不会丢。 */
  function setRowValue(r, text) {
    if (!r) return;
    var right = r.querySelector('.set-row-right');
    if (!right) return;
    var v = right.querySelector('.set-row-value');
    if (!v) {
      v = h('span', 'set-row-value', text);
      right.insertBefore(v, right.firstChild);
      return;
    }
    v.textContent = text;
  }

  /* ---------------------------- 表单 ---------------------------- */

  function fieldShell(label, hint) {
    var wrap = h('div', 'set-field');
    wrap.appendChild(h('label', 'set-label', label));
    if (hint) wrap.appendChild(h('p', 'set-hint', hint));
    return wrap;
  }

  function textField(o) {
    var wrap = fieldShell(o.label, o.hint);
    var line = h('div', 'set-line');
    var input = h('input', 'set-input');
    input.type = o.password ? 'password' : 'text';
    input.value = o.value == null ? '' : String(o.value);
    if (o.placeholder) input.placeholder = o.placeholder;
    if (o.inputmode) input.setAttribute('inputmode', o.inputmode);
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    line.appendChild(input);

    if (o.password) {
      var eye = h('button', 'set-eye', '显示');
      eye.type = 'button';
      eye.addEventListener('click', function () {
        var showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        eye.textContent = showing ? '显示' : '隐藏';
      });
      line.appendChild(eye);
    }
    wrap.appendChild(line);
    return { el: wrap, input: input, get: function () { return input.value.trim(); } };
  }

  function numField(o) {
    var wrap = fieldShell(o.label, o.hint);
    var input = h('input', 'set-input');
    input.type = 'number';
    input.value = String(o.value == null ? '' : o.value);
    if (o.min !== undefined) input.min = String(o.min);
    if (o.max !== undefined) input.max = String(o.max);
    if (o.step !== undefined) input.step = String(o.step);
    wrap.appendChild(input);
    return {
      el: wrap,
      input: input,
      get: function () {
        var raw = String(input.value).trim();
        /* 空输入返回 null，语义是「不设置这一项，交给上层兜底」。
           以前会回落到初始值，于是「清空输入框」这个动作等于没做。 */
        if (raw === '') return null;
        var v = parseFloat(raw);
        if (isNaN(v)) return o.value == null ? null : o.value;
        if (o.min !== undefined && v < o.min) v = o.min;
        if (o.max !== undefined && v > o.max) v = o.max;
        return v;
      }
    };
  }

  /* 多行文本。人设正文、以后的世界书条目都用它 */
  function textArea(o) {
    var wrap = fieldShell(o.label, o.hint);
    var ta = h('textarea', 'set-textarea');
    ta.value = o.value == null ? '' : String(o.value);
    ta.rows = o.rows || 8;
    if (o.placeholder) ta.placeholder = o.placeholder;
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('spellcheck', 'false');
    wrap.appendChild(ta);

    if (o.counter) {
      var count = h('p', 'set-count', '');
      wrap.appendChild(count);
      var sync = function () { count.textContent = ta.value.length + ' 字'; };
      ta.addEventListener('input', sync);
      sync();
    }
    return { el: wrap, input: ta, get: function () { return ta.value; } };
  }

  function switchField(o) {
    var wrap = h('div', 'set-field set-field-row');
    var main = h('div', 'set-field-main');
    main.appendChild(h('label', 'set-label', o.label));
    if (o.hint) main.appendChild(h('p', 'set-hint', o.hint));
    wrap.appendChild(main);

    var lab = h('label', 'set-switch');
    var input = h('input');
    input.type = 'checkbox';
    input.checked = !!o.value;
    lab.appendChild(input);
    lab.appendChild(h('span', 'set-switch-track'));
    wrap.appendChild(lab);
    return { el: wrap, input: input, get: function () { return input.checked; } };
  }

  function button(label, kind, onClick) {
    var b = h('button', 'btn' + (kind ? ' btn-' + kind : ''), label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', function () { onClick(b); });
    return b;
  }

  /* 段落式正文块，用于页面里的说明文字 */
  function note(text) {
    return h('p', 'set-group-note', text);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ---------------------------- 时间 ---------------------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function timeStr(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dateStr(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function relativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 0) return dateStr(ts);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    return dateStr(ts);
  }

  /* ------------------------- 文件存取（零依赖） ------------------------- */

  /* Blob + a[download]。file:// 下也能用，不依赖任何库。
     导出备份、导出人设预设都走这一个，别再各写一份。 */
  function downloadText(fileName, text, mime) {
    try {
      var blob = new global.Blob([text], {
        type: (mime || 'text/plain') + ';charset=utf-8'
      });
      var url = global.URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 选一个文本文件读进来。回调给 (正文, 文件名) */
  function pickTextFile(accept, onText, onError) {
    var input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (input.parentNode) input.parentNode.removeChild(input);
      if (!f) return;
      var reader = new global.FileReader();
      reader.onload = function () { onText(String(reader.result || ''), f.name); };
      reader.onerror = function () { if (onError) onError('读不出这个文件'); };
      reader.readAsText(f);
    });
    document.body.appendChild(input);
    input.click();
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.ui = {
    h: h,
    group: group,
    row: row,
    setRowValue: setRowValue,
    fieldShell: fieldShell,
    textField: textField,
    numField: numField,
    textArea: textArea,
    switchField: switchField,
    button: button,
    note: note,
    fmtBytes: fmtBytes,
    timeStr: timeStr,
    dateStr: dateStr,
    relativeTime: relativeTime,
    downloadText: downloadText,
    pickTextFile: pickTextFile
  };

})(window);
