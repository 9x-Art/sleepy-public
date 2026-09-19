/* ============================================================
   page-wj-style.js — 帷境 · 文风设置台
   依赖：wj-data.js、ui.js
   被依赖：门厅右上「文风」（编辑全局）、创建流程第 5 步（编辑本篇）

   ★ 两种进入方式，两种作用域：
     带 workId  → 调**这一篇**的文风与雷区；
     不带       → 调**全局**雷区与默认底座（它管所有作品）。
     作用域写在页面第一句话里，别让人猜自己在改哪一份。

   ★ 改动走「草稿 — 保存」模型（跟外观 App 同一套交互）：
     滑杆、底座、雷区都只先动预览，点「保存」才写档 ——
     文风是一组要一起看效果才成立的东西，边调边落库会让人
     不敢试。页面顶部写清楚这一点。

   ★ 这里只有用户看得见的那一半（控制台）。发动机在
     文风引擎：五层八股拦截、雷区命中、只重写问题段、
     人物声音差异与跨章漂移检查 —— 那是 T4。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var h = Sleepy.ui.h;
  var D = function () { return Sleepy.wj; };

  var view = { workId: null, scope: 'global', dirty: false };

  function btn(text, cls, fn) {
    var b = h('button', cls, text);
    b.type = 'button';
    b.onclick = fn;
    return b;
  }

  /* 页面内的草稿：进页时从存档快照一份，改动只动它 */
  var draft = null;

  function Snapshot(work) {
    if (work) {
      var st = D().styleOf(work);
      return {
        styleId: st.id,
        params: { distance: st.params.distance, density: st.params.density,
          pace: st.params.pace, dialogue: st.params.dialogue },
        custom: !!work.style,
        rules: (work.workRules || []).slice().map(function (r) { return shallow(r); }),
        workRules: null
      };
    }
    var c = D().styleCfg();
    return {
      styleId: c.preset || '静水',
      params: { distance: c.distance, density: c.density,
        pace: c.pace, dialogue: c.dialogue },
      custom: false,
      rules: (c.globalRules || []).slice().map(function (r) { return shallow(r); }),
      workRules: null
    };
  }

  function shallow(o) {
    var n = {};
    for (var k in o) if (o.hasOwnProperty(k)) n[k] = o[k];
    return n;
  }

  function isPresetExact(id) {
    var p = D().STYLE_PRESETS[id];
    if (!p) return false;
    return p.distance === draft.params.distance && p.density === draft.params.density &&
      p.pace === draft.params.pace && p.dialogue === draft.params.dialogue;
  }

  /* --------------- 试读：参数怎么变，文字就怎么变 ---------------
     这段文本是**文风示意**，不指涉任何具体作品与人物 ——
     正式版由文风引擎按「故事愿望」生成真正的试读片段，
     它只用于比较文风，不进入正文（总纲 §6.1）。
     现在这一段之所以留在纸上，是因为「滑杆一动纸面就变」
     是这个页面唯一的手感，不能空着。 */
  function sampleText() {
    var p = draft.params;
    var near = p.distance < 45;
    var far = p.distance > 68;
    var dense = p.density > 60;
    var fast = p.pace > 62;
    var talk = p.dialogue > 60;

    var a = near
      ? '门合上时，她先听见锁舌落定，才发现自己一直捏着那张折过两次的纸。'
      : far
        ? '门在走廊尽头合上。她停在原处，手里的纸沿旧折痕垂下来。'
        : '门关上了。她站在走廊里，纸还捏在手上。';
    var b = talk
      ? '“你早就知道。”她说。对方没有解释，只把椅子推回原位。'
      : '桌边那把椅子被推回原位。没有人解释那份迟到的名单。';
    var c = fast
      ? '她把纸收好，转身去找还在楼下等消息的人。'
      : '她没有立刻展开它。楼下的脚步声来过一次，又慢慢远了。';
    var d = dense
      ? '灯影擦过纸面，旧墨在纤维里留下浅淡的洇痕，却没有替任何人说出答案。'
      : '';

    var parts = [a, b, c];
    if (d) parts.splice(2, 0, d);
    return parts;
  }

  function sampleTitle() {
    var p = draft.params;
    var dist = p.distance < 45 ? '贴身' : (p.distance > 68 ? '旁观' : '跟随');
    var pace = p.pace > 62 ? '稳定推进' : (p.pace < 40 ? '慢燃停驻' : '自然流动');
    return dist + '叙述 · ' + pace;
  }

  /* ---------------------------- 绘制 ---------------------------- */
  function paint(ctx) {
    var body = ctx.body;
    body.innerHTML = '';

    var work = view.workId ? D().get(view.workId) : null;
    ctx.setTitle('文风设置');
    ctx.setActions([
      (function () {
        var b = h('button', 'wj-head-btn' + (view.dirty ? ' is-on' : ''), '保存');
        b.type = 'button';
        b.onclick = function () { doSave(ctx); };
        return b;
      })()
    ]);

    var shell = h('div', 'wj-shell wj-style');

    var head = h('div', 'wj-head');
    head.appendChild(h('div', 'wj-eyebrow', work ? 'THIS STORY' : 'ALL STORIES'));
    head.appendChild(h('h1', 'wj-h1', work ? '《' + work.title + '》的文风' : '默认文风与雷区'));
    head.appendChild(h('p', 'wj-sub', work
      ? '只作用于这一篇。改动先只影响下面的试读，点右上「保存」才写入。'
      : '这一份是所有作品的默认。每篇仍可以单独改，改过的按那一篇走。'));
    shell.appendChild(head);

    /* -------- 六套底座 -------- */
    var p1 = h('div', 'wj-panel');
    p1.appendChild(h('h2', 'wj-h2', '文风底座'));
    p1.appendChild(h('p', 'wj-sub', '预设只是起点。改过任何一根滑杆，它就成为这一篇的独立配置。'));
    var presets = h('div', 'wj-presets');
    Object.keys(D().STYLE_PRESETS).forEach(function (name) {
      var pr = D().STYLE_PRESETS[name];
      var on = draft.styleId === name && isPresetExact(name);
      var c = h('button', 'wj-preset' + (on ? ' is-on' : ''));
      c.type = 'button';
      c.appendChild(h('b', null, name));
      c.appendChild(h('small', null, pr.desc));
      c.onclick = function () {
        draft.styleId = name;
        draft.custom = false;
        draft.params = { distance: pr.distance, density: pr.density,
          pace: pr.pace, dialogue: pr.dialogue };
        view.dirty = true;
        paint(ctx);
      };
      presets.appendChild(c);
    });
    p1.appendChild(presets);
    shell.appendChild(p1);

    /* -------- 四根参数 -------- */
    var p2 = h('div', 'wj-panel');
    p2.appendChild(h('h2', 'wj-h2', '四项核心参数'));
    p2.appendChild(h('p', 'wj-sub', '四项一起决定读起来是什么样，不是把「唯美」当一层滤镜糊在所有角色身上。'));
    D().STYLE_PARAMS.forEach(function (sp) {
      var v = draft.params[sp.key];
      var row = h('div', 'wj-control');
      row.appendChild(h('label', 'wj-control-label', sp.name));
      var range = h('input', 'wj-range');
      range.type = 'range';
      range.min = '0';
      range.max = '100';
      range.value = String(v);
      var out = h('output', 'wj-control-out',
        v < 38 ? sp.lo : (v > 66 ? sp.hi : '均衡'));
      range.oninput = function () {
        draft.params[sp.key] = Number(range.value);
        draft.custom = true;
        view.dirty = true;
        out.textContent = Number(range.value) < 38 ? sp.lo
          : (Number(range.value) > 66 ? sp.hi : '均衡');
        refreshPaper();
      };
      row.appendChild(range);
      row.appendChild(out);
      p2.appendChild(row);
    });
    shell.appendChild(p2);

    /* -------- 试读纸 -------- */
    var p3 = h('div', 'wj-panel');
    p3.appendChild(h('h2', 'wj-h2', '动态试读'));
    p3.appendChild(h('p', 'wj-sub', '只用于比较文风，不进入正式正文，也不能邀请同席。'));
    var paper = h('div', 'wj-paper');
    paper.appendChild(h('div', 'wj-paper-kicker', 'STYLE PREVIEW'));
    paper.appendChild(h('h3', 'wj-paper-title'));
    var sample = h('div', 'wj-sample');
    paper.appendChild(sample);
    paper.appendChild(h('p', 'wj-paper-note',
      '这段是文风示意，不是你的作品正文。正式版会按你的故事愿望生成真正的试读片段。'));
    p3.appendChild(paper);
    shell.appendChild(p3);

    /* -------- 雷区 -------- */
    var p4 = h('div', 'wj-panel');
    p4.appendChild(h('h2', 'wj-h2', '表达雷区'));
    p4.appendChild(h('p', 'wj-sub', work
      ? '全局规则影响所有剧本；本篇规则只在当前作品中生效。'
      : '这里维护的是全局规则。某一段落有问题可以在阅读页上直接圈出来。'));

    var tabs = h('div', 'wj-tabs');
    [['global', '全局雷区'], ['work', '本篇雷区']].forEach(function (t) {
      if (t[0] === 'work' && !work) return;
      var b = h('button', 'wj-tab' + (view.scope === t[0] ? ' is-on' : ''), t[1]);
      b.type = 'button';
      b.onclick = function () { view.scope = t[0]; paint(ctx); };
      tabs.appendChild(b);
    });
    p4.appendChild(tabs);

    var listKey = (view.scope === 'work' && work) ? 'workRules' : 'rules';
    if (listKey === 'workRules') {
      if (!draft.workRules) draft.workRules = (work.workRules || []).slice().map(shallow);
    }
    var list = draft[listKey] || [];

    var ruleList = h('div', 'wj-rule-list');
    if (!list.length) {
      ruleList.appendChild(h('p', 'wj-sub', '这里还没有规则。'));
    }
    list.forEach(function (r, i) {
      var row = h('div', 'wj-rule');
      var input = h('input', 'wj-rule-text');
      input.value = r.text || '';
      input.placeholder = '写下词、句式或表达问题';
      input.onchange = function () {
        list[i].text = input.value;
        view.dirty = true;
      };
      row.appendChild(input);
      var sel = h('select', 'wj-rule-strength');
      D().RULE_STRENGTH.forEach(function (s) {
        var o = h('option', null, s);
        o.value = s;
        if (r.strength === s) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        list[i].strength = sel.value;
        view.dirty = true;
      };
      row.appendChild(sel);
      row.appendChild(btn('删除', 'wj-rule-del', function () {
        list.splice(i, 1);
        view.dirty = true;
        paint(ctx);
      }));
      if (r.confirmed === false) {
        row.appendChild(h('em', 'wj-rule-cand', '候选'));
      }
      ruleList.appendChild(row);
    });
    p4.appendChild(ruleList);

    /* 加规则：**先进入候选区**，确认后才生效 ——
       不能因为一次不喜欢就永久污染全局设置（总纲 §9.3）。 */
    var addRow = h('div', 'wj-rule-add');
    var newText = h('input', 'wj-rule-text');
    newText.placeholder = '写下词、句式或表达问题';
    addRow.appendChild(newText);
    var newStr = h('select', 'wj-rule-strength');
    D().RULE_STRENGTH.forEach(function (s) {
      var o = h('option', null, s);
      o.value = s;
      if (s === '限制频率') o.selected = true;
      newStr.appendChild(o);
    });
    addRow.appendChild(newStr);
    addRow.appendChild(btn('加入候选', 'wj-btn wj-btn-solid', function () {
      var t = newText.value.trim();
      if (!t) { Sleepy.toast('先写一条要避开的表达'); return; }
      list.push({ text: t, strength: newStr.value, confirmed: false });
      newText.value = '';
      view.dirty = true;
      paint(ctx);
    }));
    p4.appendChild(addRow);
    p4.appendChild(h('p', 'wj-notice',
      '新规则先进入候选区，只有你点「确认生效」之后才会参与检查。'));
    shell.appendChild(p4);

    /* -------- 生效边界 -------- */
    var p5 = h('div', 'wj-panel');
    p5.appendChild(h('h2', 'wj-h2', '生效边界'));
    p5.appendChild(h('p', 'wj-sub',
      '人物逻辑与既有事实优先于文风。局部导演指令只作用于指定段落；' +
      '雷区也不会把作品压成没有呼吸的安全文。'));
    shell.appendChild(p5);

    var acts = h('div', 'wj-actions');
    acts.appendChild(btn(work ? '保存并返回开帷' : '保存当前设置', 'wj-btn wj-btn-solid',
      function () { doSave(ctx, true); }));
    if (work) {
      acts.appendChild(btn('先不改，返回', 'wj-quiet', function () { Sleepy.nav.back(); }));
    }
    shell.appendChild(acts);

    body.appendChild(shell);
    refreshPaper();
  }

  /* 只重画纸面（滑杆拖动时用，不重建整页 —— 重建会把手指底下的
     滑杆换掉，拖动会断） */
  function refreshPaper() {
    var title = document.querySelector('.wj-paper-title');
    var sample = document.querySelector('.wj-sample');
    if (!title || !sample) return;
    title.textContent = sampleTitle();
    sample.innerHTML = '';
    sampleText().forEach(function (t) {
      if (!t) return;
      sample.appendChild(h('p', null, t));
    });
  }

  function doSave(ctx, goBack) {
    var work = view.workId ? D().get(view.workId) : null;
    var exact = isPresetExact(draft.styleId);
    if (work) {
      D().mutate(work.id, function (w) {
        w.styleId = draft.styleId;
        w.style = exact ? null : {
          distance: draft.params.distance, density: draft.params.density,
          pace: draft.params.pace, dialogue: draft.params.dialogue
        };
        w.workRules = (draft.workRules || []).slice();
        return w;
      });
    } else {
      D().saveStyleCfg({
        preset: draft.styleId,
        distance: draft.params.distance, density: draft.params.density,
        pace: draft.params.pace, dialogue: draft.params.dialogue,
        globalRules: (draft.rules || []).slice()
      });
    }
    view.dirty = false;
    Sleepy.toast('文风设置已保存');
    if (goBack) { Sleepy.nav.back(); return; }
    paint(ctx);
  }

  Sleepy.register('wj-style', {
    title: '文风设置',
    render: function (ctx) {
      var p = ctx.params || {};
      var id = p.workId || null;
      /* 换了一个作用域（本篇 ↔ 全局）才重置草稿与页签，
         同一个作品重进不重置 —— 从创建流程来回跳要保持手感。 */
      if (id !== view.workId) {
        view.workId = id;
        view.scope = id ? 'work' : 'global';
      }
      draft = Snapshot(id ? D().get(id) : null);
      view.dirty = false;
      ctx.__paint = function () { paint(ctx); };
      paint(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__paint) ctx.__paint();
    }
  });

})(window);
