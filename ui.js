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
    /* 第三参不只收字符串：收 DOM 节点就 append，收数组就逐个放进去
       （字符串转文本节点）。以前只认字符串，谁手滑传了个元素进去，
       textContent 就变成「[object HTMLElement]」—— 认知地图和「我」页
       都这么烂过。现在类型本身兜底，这类 bug 整类消失。 */
    if (text !== undefined && text !== null) {
      /* 用 nodeType 鸭子判断而不是 instanceof Node ——
         无头测试的 DOM 桩里没有 Node 这个全局，写 instanceof 会直接炸。 */
      if (text.nodeType) {
        el.appendChild(text);
      } else if (Array.isArray(text)) {
        text.forEach(function (t) {
          if (t === undefined || t === null) return;
          el.appendChild(t && t.nodeType ? t : document.createTextNode(String(t)));
        });
      } else {
        el.textContent = text;
      }
    }
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

  /* 更新行右侧那个小胶囊（row({badge, badgeKind}) 造出来的）。
     传空字符串 = 去掉它。从下级页返回要刷新状态徽标时用这个 ——
     以前没有这个函数，有人拿 setRowValue 去改 badge，
     结果 setRowValue 找不到 .set-row-value 就又插了一个，行上出现两个文字。 */
  function setRowBadge(r, text, kind) {
    if (!r) return;
    var right = r.querySelector('.set-row-right');
    if (!right) return;
    var b = right.querySelector('.set-badge');
    if (!text) { if (b && b.parentNode) b.parentNode.removeChild(b); return; }
    if (!b) {
      right.appendChild(h('span', 'set-badge set-badge-' + (kind || 'dim'), text));
      return;
    }
    b.textContent = text;
    b.className = 'set-badge set-badge-' + (kind || 'dim');
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

  /* ------------------------- 应用内弹层 ------------------------- */

  /* 为什么不用原生 prompt() / confirm()：
     它们弹出来的是浏览器自己的对话框 —— 标题写着「127.0.0.1:5173 显示」，
     旁边还挂着地址栏。在一个「小手机」里冒出这种东西，沉浸感当场就没了，
     手机上更难看（iOS 还会把整个页面顶上去）。
     这里用跟心声面板同一套材质做应用内版本。

     用法跟原生几乎一样，区别是返回 Promise：

       var name = await ui.prompt({ title: '给这个对话起个名字？', value: '新对话' });
       if (name === null) return;                          // 用户取消
       if (await ui.confirm({ title: '确定删除？', ok: '删除', danger: true })) { ... }

     全局单例：同一时刻只有一个弹层，连点不会叠出一堆。
     遮罩 / ESC / 取消 都算取消（input 返回 null，confirm 返回 false）。
     输入框里按回车＝确定。 */

  /* 两个变量分开管，别合成一个：
     dialogEls —— DOM，只建一次，之后一直复用
     dialog    —— 当前这一次打开的会话（null = 没打开）

     一开始我把两者合成一个变量，关闭时清掉引用，下次打开又新建一份 DOM，
     页面上就堆着好几层弹层 —— 症状是「点了按钮像没反应」，
     其实新弹层开在最后面，被先前那份残留挡着。 */
  var dialogEls = null;
  var dialog = null;

  function closeDialog(result) {
    if (!dialog) return;
    var d = dialog;
    /* 先断开引用：resolve 的回调里可能马上又要开一个弹层，
       不先清掉的话新开的那个会被当成「旧的」关掉 */
    dialog = null;
    dialogEls.mask.classList.remove('is-open');
    dialogEls.card.classList.remove('is-open');
    if (d.done) d.done(result);
  }

  /* 只负责建 DOM。建过就复用，永远不会有第二份 */
  function ensureDialog() {
    if (dialogEls) return dialogEls;

    /* 挂到手机壳里而不是 body，这样它跟着手机屏一起裁剪、一起居中 */
    var host = document.getElementById('phone') || document.body;

    var mask = h('div', 'dl-mask');
    var card = h('div', 'dl-card');
    var title = h('p', 'dl-title');
    var note = h('p', 'dl-note');

    var input = h('input', 'dl-input');
    input.type = 'text';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');

    var acts = h('div', 'dl-acts');
    var cancelBtn = h('button', 'dl-btn', '取消');
    cancelBtn.type = 'button';
    var okBtn = h('button', 'dl-btn dl-btn-ok', '确定');
    okBtn.type = 'button';
    acts.appendChild(cancelBtn);
    acts.appendChild(okBtn);

    var fieldsWrap = h('div', 'dl-fields');   /* 多字段模式用（转账的金额 + 备注） */

    card.appendChild(title);
    card.appendChild(note);
    card.appendChild(fieldsWrap);
    card.appendChild(input);
    card.appendChild(acts);
    host.appendChild(mask);
    host.appendChild(card);

    /* 取消时给什么值：输入框给 null，确认框给 false */
    function cancelValue() {
      return (dialog && dialog.kind === 'confirm') ? false : null;
    }

    function submit() {
      if (!dialog) return;
      if (dialog.kind === 'confirm') { closeDialog(true); return; }
      /* 多字段模式：resolve 一个对象（键 = field.key） */
      if (dialog.fields && dialog.fields.length) {
        var out = {};
        dialog.fields.forEach(function (f) { out[f.key] = f.input.value; });
        closeDialog(out);
        return;
      }
      closeDialog(input.value);
    }

    mask.addEventListener('click', function () { closeDialog(cancelValue()); });
    cancelBtn.addEventListener('click', function () { closeDialog(cancelValue()); });
    okBtn.addEventListener('click', function () { submit(); });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(cancelValue()); }
    });
    document.addEventListener('keydown', function (e) {
      if (!dialog) return;
      if (e.key === 'Escape') closeDialog(cancelValue());
    });

    dialogEls = {
      mask: mask, card: card, title: title, note: note,
      fieldsWrap: fieldsWrap,
      input: input, okBtn: okBtn,
      submit: submit   /* openDialog 的字段输入框也要能触发提交（Enter） */
    };
    return dialogEls;
  }

  function openDialog(o) {
    o = o || {};
    /* 上一个还没关就又开一个：把旧的当成取消，否则它的 Promise 永远挂着 */
    if (dialog) closeDialog(null);

    var els = ensureDialog();
    var kind = o.kind === 'confirm' ? 'confirm' : 'input';

    els.title.textContent = o.title || '';
    els.note.textContent = o.note || '';
    els.note.style.display = o.note ? '' : 'none';
    els.okBtn.textContent = o.ok || (kind === 'confirm' ? '确定' : '保存');
    els.okBtn.className = 'dl-btn dl-btn-ok' + (o.danger ? ' is-danger' : '');
    /* 宽版：编辑长文本（比如聊天里的一个气泡）时单行卡片太局促 */
    if (els.card && els.card.classList) els.card.classList[o.wide ? 'add' : 'remove']('is-wide');

    /* 多字段模式：o.fields = [{key,label,value,placeholder}, ...]。
       resolve 出来的是对象（键 = key），单输入框路径照旧返回字符串 ——
       已有的调用点一个都不用改。典型用户：转账的「金额 + 备注」
       （原来挤在一个框里写「68 买奶茶」，用户说备注该有自己的框）。 */
    var live = [];
    var fields = Array.isArray(o.fields) && o.fields.length ? o.fields : null;
    els.fieldsWrap.innerHTML = '';
    els.fieldsWrap.style.display = fields ? '' : 'none';
    els.input.style.display = (kind === 'input' && !fields) ? '' : 'none';
    els.input.value = o.value == null ? '' : String(o.value);
    els.input.placeholder = o.placeholder || '';
    if (fields) {
      fields.forEach(function (f) {
        var lab = h('label', 'dl-field');
        if (f.label) lab.appendChild(h('span', 'dl-field-label', f.label));
        /* f.multiline → 多行（编辑聊天气泡这种长句子用）。
           多行**不接 Enter 提交** —— 换行是内容的一部分。 */
        var inp = f.multiline ? h('textarea', 'dl-input dl-textarea') : h('input', 'dl-input');
        if (!f.multiline) inp.type = 'text';
        else inp.rows = Math.max(2, Number(f.rows) || 4);
        inp.value = f.value == null ? '' : String(f.value);
        inp.placeholder = f.placeholder || '';
        inp.setAttribute('autocapitalize', 'off');
        inp.setAttribute('autocorrect', 'off');
        inp.setAttribute('spellcheck', 'false');
        if (!f.multiline) {
          inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); els.submit(); }
          });
        }
        lab.appendChild(inp);
        els.fieldsWrap.appendChild(lab);
        live.push({ key: f.key || 'value', input: inp });
      });
    }

    return new Promise(function (resolve) {
      dialog = { kind: kind, done: resolve, fields: live };
      els.mask.classList.add('is-open');
      els.card.classList.add('is-open');
      if (kind === 'input') {
        /* 等一帧再聚焦，刚 display 出来的元素直接 focus 在部分浏览器上不生效 */
        var first = fields ? live[0].input : els.input;
        setTimeout(function () { first.focus(); first.select(); }, 30);
      }
    });
  }

  /* 文本输入弹窗。确定 → 输入内容（未 trim，交给调用方决定），取消 → null */
  function prompt(o) {
    if (typeof o === 'string') o = { title: o };
    o = o || {};
    o.kind = 'input';
    return openDialog(o);
  }

  /* 确认弹窗。确定 → true，取消 → false */
  function confirmBox(o) {
    if (typeof o === 'string') o = { title: o };
    o = o || {};
    o.kind = 'confirm';
    if (o.ok === undefined) o.ok = '确定';
    return openDialog(o);
  }

  /* ==================== 锚点浮层 / 模型选择 ====================
     「贴着一个元素弹出来的小面板」。模型名旁边那枚小圆钮用它，
     以后的聊天长按菜单也用同一套定位（别各写一份）。 */

  var activePop = null;

  function closePopover() {
    if (!activePop) return;
    var pop = activePop;
    activePop = null;
    if (pop.cleanup) pop.cleanup();
    if (pop.el && pop.el.parentNode) pop.el.parentNode.removeChild(pop.el);
  }

  /* anchorPopover(anchorEl, {className, width})
       返回 { el, place(), close() }。el 是面板本体，往里塞内容；
       内容尺寸变了（比如列表填进去之后）要再调一次 place() 重新贴。
     同一时刻只允许一个浮层 —— 开新的会把旧的收掉。

     ⚠️ 面板挂到 #phone 上，**不能挂进页面里**：页面自身是可滚动的
     （.page 有 overflow-y:auto），挂在页面里的 absolute 元素会跟着内容
     一起滚走。聊天记录搜索（page-chat 的 openSearch）已经为这个坑返工过，
     注释留在那边；这里做成通用件，别再踩第三次。 */
  function anchorPopover(anchorEl, opt) {
    opt = opt || {};
    closePopover();

    var host = (document.getElementById && document.getElementById('phone')) || document.body;
    var pop = h('div', 'anchor-pop glass' + (opt.className ? ' ' + opt.className : ''));
    pop.setAttribute('role', 'dialog');
    if (opt.width) pop.style.width = opt.width;
    host.appendChild(pop);

    var GAP = 8, EDGE = 10;
    /* 上边界要避开状态栏（它是 absolute、高约 32px，而浮层 z-index 更高，
       压上去会盖住时间和电量）。这里给 44 = 状态栏 + 一点余量。 */
    var TOP_MIN = 44;

    function place() {
      /* 元素已经不在文档里（页面被 rebuild / 切走了）→ 自己收掉，
         否则浮层会孤零零地飘在新页面上面 */
      if (!anchorEl || anchorEl.isConnected === false) { closePopover(); return; }
      var r = anchorEl.getBoundingClientRect();
      var hr = host.getBoundingClientRect();
      if (!r || !hr) return;

      /* 锚点被滚出手机框了就别贴了 */
      if (r.bottom < hr.top || r.top > hr.bottom) { closePopover(); return; }

      var pw = pop.offsetWidth || 260;
      var ph = pop.offsetHeight || 200;

      var left = r.left - hr.left;
      var maxLeft = hr.width - pw - EDGE;
      left = Math.max(EDGE, Math.min(left, Math.max(EDGE, maxLeft)));

      var below = hr.bottom - r.bottom - GAP;
      var above = r.top - hr.top - GAP;
      /* 下面**装不下整个面板**、且上面更宽裕 → 往上翻。
         判据要用完整高度（ph + GAP + EDGE），不能只比一个固定的小阈值：
         面板三四百像素高的时候，只比 200 会判成「放得下」，然后被
         clamp 到贴底，正好糊住输入框那一栏。 */
      var need = ph + GAP + EDGE;
      var up = (below < need) && (above > below);
      var top = up ? (r.top - hr.top - ph - GAP) : (r.bottom - hr.top + GAP);
      top = Math.max(TOP_MIN, Math.min(top, Math.max(TOP_MIN, hr.height - ph - EDGE)));

      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
      pop.classList.toggle('is-up', up);
    }

    /* 浮层里的滚动不该被当成「页面滚了」→ 只认浮层外面的滚动 */
    function onScroll(e) {
      if (pop.contains && e && e.target && pop.contains(e.target)) return;
      place();
    }
    function onKey(e) { if (e && e.key === 'Escape') closePopover(); }
    function onDown(e) {
      if (pop.contains && e && e.target && pop.contains(e.target)) return;
      if (anchorEl && e && (e.target === anchorEl || (anchorEl.contains && anchorEl.contains(e.target)))) return;
      closePopover();
    }

    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', onKey);
    /* capture 阶段：比元素自己的 click 更早拿到，点哪儿都能收 */
    document.addEventListener('pointerdown', onDown, true);

    anchorEl.classList.add('is-pop-open');
    activePop = {
      el: pop, anchor: anchorEl,
      cleanup: function () {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', place);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onDown, true);
        if (anchorEl.classList) anchorEl.classList.remove('is-pop-open');
      }
    };

    return { el: pop, place: place, close: closePopover };
  }

  /* modelPicker({anchor, load, onPick, tip})
       点小圆钮 → 贴着一个浮层，框里自己滚动 + 顶部搜索框即时筛，
       点一个就填进去、框消失。

     为什么做成浮层而不是把结果铺在页面上：拉一次可能回 60 个模型名，
     铺在页面里 = 整页被拉得很长，用户得一直往下滚**整页**（用户原话：
     「现在是直接全部铺在屏幕上，就会很长，我要一直往下拉」）。
     浮层里自己滚，页面高度一点不变。

     ui 这一层不发请求（见文件头）—— load() 由调用方传进来。 */
  /* 拉取模型的刷新图标。四处共用一份 —— 以前这段 SVG 连同按钮一起抄了四遍。 */
  var REFRESH_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round"><path d="M4 10a6 6 0 0 1 10.4-4.1M16 10a6 6 0 0 1-10.4 4.1M14.5 2.5v3.6h-3.6M5.5 17.5v-3.6h3.6"/></svg>';

  /* modelPickButton({load, onPick, tip})
       造那枚「拉取模型」小圆钮（含图标）并接好浮层，返回按钮元素。
       设置主 API / 副 API / 生图 / 线下四处共用这一个。 */
  function modelPickButton(o) {
    o = o || {};
    var b = h('button', 'set-mini-ic');
    b.type = 'button';
    b.title = '拉取模型列表';
    b.setAttribute('aria-label', '拉取模型列表');
    b.innerHTML = REFRESH_SVG;
    b.addEventListener('click', function () {
      modelPicker({ anchor: b, load: o.load, onPick: o.onPick, tip: o.tip });
    });
    return b;
  }

  function modelPicker(o) {
    o = o || {};
    var anchor = o.anchor;
    if (!anchor) return null;

    /* 再点一次就收起来（开关语义） */
    if (activePop && activePop.anchor === anchor) { closePopover(); return null; }

    var pop = anchorPopover(anchor, { className: 'mp-pop' });

    var head = h('div', 'mp-head');
    var search = h('input', 'mp-search');
    search.type = 'text';
    search.placeholder = '搜索模型名';
    search.setAttribute('autocapitalize', 'off');
    search.setAttribute('autocorrect', 'off');
    search.setAttribute('spellcheck', 'false');
    head.appendChild(search);
    pop.el.appendChild(head);

    var hint = h('p', 'mp-hint', o.tip || '');
    if (!o.tip) hint.style.display = 'none';
    pop.el.appendChild(hint);

    var list = h('div', 'mp-list');
    pop.el.appendChild(list);

    var all = [];
    var loading = false;

    function showMsg(text, cls) {
      list.innerHTML = '';
      list.appendChild(h('p', 'mp-msg' + (cls ? ' ' + cls : ''), text));
    }

    function renderBox(q) {
      q = String(q || '').trim().toLowerCase();
      var hits = q ? all.filter(function (m) {
        return String(m).toLowerCase().indexOf(q) >= 0;
      }) : all;
      list.innerHTML = '';
      if (!hits.length) { list.appendChild(h('p', 'mp-msg', '没有匹配的')); return; }
      /* 一次最多渲染 200 条：真拿到几百个也不至于卡 */
      hits.slice(0, 200).forEach(function (id) {
        var row = h('button', 'mp-row');
        row.type = 'button';
        row.appendChild(h('span', 'mp-row-name', id));
        row.addEventListener('click', function () {
          if (o.onPick) o.onPick(id);
          closePopover();               /* 选完即收（用户点名要的） */
        });
        list.appendChild(row);
      });
    }

    function run() {
      if (loading) return;
      loading = true;
      showMsg('正在拉取…');
      pop.place();

      var out = null;
      try { out = o.load ? o.load() : null; } catch (e) {
        loading = false;
        showMsg('没拉到：' + ((e && e.message) || '拉取出错'), 'is-bad');
        pop.place();
        return;
      }
      /* load() 允许直接返回结果对象（比如「先选一个接口」这种同步失败），
         不强制调用方包 Promise */
      var p = (out && typeof out.then === 'function') ? out : Promise.resolve(out);

      p.then(function (res) {
        loading = false;
        if (!res) { showMsg('没拉到：没有返回', 'is-bad'); pop.place(); return; }
        if (!res.ok) {
          /* 失败原因原样透出来（别让「连不上/401/超时」都被吞成一句话） */
          showMsg('没拉到：' + (res.message || res.error || '未知错误'), 'is-bad');
          if (res.detail) list.appendChild(h('p', 'mp-detail', String(res.detail).slice(0, 300)));
          pop.place();
          return;
        }
        all = Array.isArray(res.models) ? res.models : [];
        if (!all.length) { showMsg('接口返回了空列表，可以直接手填模型名'); pop.place(); return; }
        hint.textContent = '拉到 ' + all.length + ' 个，点一个填进模型名（用上面的框搜）';
        hint.style.display = '';
        renderBox('');
        pop.place();
        /* 故意不自动聚焦搜索框：手机上聚焦会弹键盘，正好把浮层盖掉一半 */
      }, function (e) {
        loading = false;
        showMsg('没拉到：' + ((e && e.message) || '请求出错'), 'is-bad');
        pop.place();
      });
    }

    search.addEventListener('input', function () {
      renderBox(search.value);
      pop.place();
    });

    run();
    return pop.el;
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.ui = {
    h: h,
    group: group,
    row: row,
    setRowValue: setRowValue,
    setRowBadge: setRowBadge,
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
    pickTextFile: pickTextFile,
    /* 应用内弹层。注意是 Promise 版，不是原生 prompt / confirm */
    prompt: prompt,
    confirm: confirmBox,
    /* 锚点浮层：模型选择器用，聊天长按菜单以后也用同一套定位 */
    anchorPopover: anchorPopover,
    modelPicker: modelPicker,
    modelPickButton: modelPickButton,
    closePopover: closePopover
  };

})(window);
