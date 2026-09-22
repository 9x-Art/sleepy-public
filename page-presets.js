/* ============================================================
   page-presets.js — 预设（预设注入系统的配置 app）
   依赖：store.js、core.js、ui.js、app.js、prompt-engine.js
   页面：presets → preset-card / preset-custom-edit / preset-preview

   定位（施工卡-预设注入系统-v1）：
   · 开发期：内置 prompt 卡可见可编辑（调试需要）
   · 面向用户后：locked 卡只显示「有这个注入 + 估算 tokens」，
     内容不可见不可编辑；用户能动的只有自定义注入卡
   · 开发者模式没有显眼入口 —— 隐蔽开关在设置页（连点「关于 Sleepy」）

   UI 硬要求：不得太多圆角框。所以这里走「列表 + 分隔线」的扁平结构，
   只在必须表单的地方借 ui 的组件，不套一层层卡片。
   ============================================================ */
(function (global) {
  'use strict';

  global.Sleepy = global.Sleepy || {};
  var Sleepy = global.Sleepy;
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var h = ui.h;

  /* 引擎对象在 prompt-engine.js 里，加载顺序保证它在前面。
     这里只取一次引用；函数都在调用时才访问字段，不吃加载期缓存。 */
  var pe = null;
  function engine() {
    if (!pe) pe = Sleepy.promptEngine;
    return pe;
  }

  function fmtTok(n) {
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  /* ==================== 页面：预设（一级） ==================== */

  Sleepy.register('presets', {
    title: '预设',
    render: function (ctx) {
      var E = engine();
      var body = ctx.body;

      function build() {
        body.innerHTML = '';
        var dev = E.isDev();
        var on = E.isEngineOn();

        /* ---- 引擎开关（唯一显眼的控制项） ---- */
        var eng = h('div', 'pp-engine' + (on ? '' : ' is-off'));
        var engMain = h('div', 'pp-engine-main');
        engMain.appendChild(h('p', 'pp-engine-title', on ? '预设注入引擎 · 开' : '预设注入引擎 · 关'));
        engMain.appendChild(h('p', 'pp-engine-sub',
          on ? '对话按槽位装配注入' : '对话用旧组装路径（排查问题时用）'));
        var engSwitch = h('label', 'set-switch');
        var cb = h('input'); cb.type = 'checkbox'; cb.checked = on;
        engSwitch.appendChild(cb);
        engSwitch.appendChild(h('span', 'set-switch-track'));
        engSwitch.addEventListener('click', function (e) {
          e.preventDefault();
          var next = !E.isEngineOn();
          E.setEngine(next);
          ctx.toast(next ? '已切到新引擎' : '已切回旧组装', 'ok');
          build();
        });
        eng.appendChild(engMain);
        eng.appendChild(engSwitch);
        body.appendChild(eng);

        /* ---- 调用类型 ---- */
        var types = h('div', 'pp-sec');
        types.appendChild(h('p', 'pp-sec-title', '调用类型'));
        var tRow = h('button', 'pp-row pp-row-active');
        tRow.type = 'button';
        var tMain = h('span', 'pp-row-main');
        tMain.appendChild(h('span', 'pp-row-label', '线上普通回复'));
        tMain.appendChild(h('span', 'pp-row-hint', 'F1 · 已实装'));
        tRow.appendChild(tMain);
        tRow.appendChild(h('span', 'pp-row-arrow', '›'));
        tRow.addEventListener('click', function () {
          global.scrollTo(0, 0);
          ctx.open('preset-card', { id: 'f1' });
        });
        types.appendChild(tRow);

        /* 已实装、但由后台模块调用的类型（2026-09-19 线下 F2 一并转正：
           page-offline 的 requestTurn 走的就是 assembleOffline）：
           线下走线下页、总结引擎和主动消息引擎在后台用各自的卡。 */
        [
          { id: 'f2', name: '线下普通回复', hint: '线下模式 · 已接' },
          { id: 'summary', name: '总结（线上累计 / 线下大）', hint: '记忆系统 v5 · 已接' },
          { id: 'proactive', name: '主动消息', hint: '主动消息引擎 · 已接' },
          { id: 'groupRound', name: '群聊一轮编排', hint: '线上群聊 · 已接' }
        ].forEach(function (t) {
          var lockedCard = !!(E.cardMeta(t.id) && E.cardMeta(t.id).locked) && !dev;
          var r = h('button', 'pp-row pp-row-active');
          r.type = 'button';
          var m = h('span', 'pp-row-main');
          m.appendChild(h('span', 'pp-row-label', t.name));
          m.appendChild(h('span', 'pp-row-hint', t.hint));
          r.appendChild(m);
          r.appendChild(h('span', 'pp-row-lock', lockedCard ? '已上锁' : '内置'));
          r.addEventListener('click', function () { ctx.open('preset-card', { id: t.id }); });
          types.appendChild(r);
        });
        body.appendChild(types);

        /* ---- 注入序列（线上）---- */
        var seq = h('div', 'pp-sec');
        seq.appendChild(h('p', 'pp-sec-title', '注入序列 · 线上'));
        seq.appendChild(h('p', 'pp-sec-note', '自上而下即注入顺序。'));

        E.onlineSlots.forEach(function (def) {
          if (def.id === 'custom' || def.id === 'history') return;
          var meta = E.cardMeta(def.id);
          var isCard = def.kind === 'card';
          var enabled = isCard ? E.cardEnabled(def.id) : true;
          var toks = isCard ? E.estimate(E.cardBody(def.id)) : 0;

          var r = h('button', 'pp-row' + (enabled ? '' : ' is-off'));
          r.type = 'button';
          var m = h('span', 'pp-row-main');
          m.appendChild(h('span', 'pp-row-label', def.name));
          m.appendChild(h('span', 'pp-row-hint', def.note ||
            (meta && meta.locked ? 'Sleepy 内置注入' : '')));
          r.appendChild(m);
          /* 上锁 UI（第三梯队 7）：非开发者模式下，内置锁卡在列表里就标出来 */
          if (meta && meta.locked && !dev) r.appendChild(h('span', 'pp-row-lock', '已上锁'));
          r.appendChild(h('span', 'pp-row-tag', def.slot));
          if (isCard && toks) r.appendChild(h('span', 'pp-row-tok', '≈' + fmtTok(toks)));
          if (!def.required) r.appendChild(h('span', 'pp-row-req', '可选'));
          r.addEventListener('click', function () { ctx.open('preset-card', { id: def.id }); });
          seq.appendChild(r);
        });
        body.appendChild(seq);

        /* ---- 注入序列（线下）---- */
        var seqOff = h('div', 'pp-sec');
        seqOff.appendChild(h('p', 'pp-sec-title', '注入序列 · 线下'));
        seqOff.appendChild(h('p', 'pp-sec-note', '线下每轮的装配顺序。'));

        E.offlineSlots.forEach(function (def) {
          /* custom 与线上一致：单独在下面「自定义注入」区块里列，
             不混进注入序列（序列里那一行点不开，看着像坏掉） */
          if (def.id === 'custom' || def.id === 'history') return;
          var isCard = def.kind === 'card';
          var meta = E.cardMeta(def.id);
          var toks = isCard ? E.estimate(E.cardBody(def.id)) : 0;

          var r = h(isCard ? 'button' : 'div', 'pp-row');
          if (isCard) r.type = 'button';
          var m = h('span', 'pp-row-main');
          m.appendChild(h('span', 'pp-row-label', def.name));
          m.appendChild(h('span', 'pp-row-hint', def.note ||
            (meta && meta.locked ? 'Sleepy 内置注入' : '')));
          r.appendChild(m);
          if (meta && meta.locked && !dev) r.appendChild(h('span', 'pp-row-lock', '已上锁'));
          r.appendChild(h('span', 'pp-row-tag', def.slot));
          if (isCard && toks) r.appendChild(h('span', 'pp-row-tok', '≈' + fmtTok(toks)));
          if (isCard) r.addEventListener('click', function () { ctx.open('preset-card', { id: def.id }); });
          seqOff.appendChild(r);
        });
        body.appendChild(seqOff);

        /* ---- 自定义注入 ---- */
        var cus = h('div', 'pp-sec');
        var cusHead = h('div', 'pp-sec-head');
        cusHead.appendChild(h('p', 'pp-sec-title', '自定义注入'));
        var addBtn = h('button', 'pp-add', '+ 新增');
        addBtn.type = 'button';
        addBtn.addEventListener('click', function () { ctx.open('preset-custom-edit', {}); });
        cusHead.appendChild(addBtn);
        cus.appendChild(cusHead);
        cus.appendChild(h('p', 'pp-sec-note',
          '线上线下的装配里都会注入 —— 位置在关系记忆（线下是世界书）之后、输出协议之前。'));

        if (!E.customCards().length) {
          cus.appendChild(h('p', 'pp-empty', '还没有自定义注入'));
        }
        E.customCards().forEach(function (cc) {
          var enabled = E.cardEnabled(cc.id);
          var r = h('button', 'pp-row' + (enabled ? '' : ' is-off'));
          r.type = 'button';
          var m = h('span', 'pp-row-main');
          m.appendChild(h('span', 'pp-row-label', cc.title));
          m.appendChild(h('span', 'pp-row-hint', '≈' + fmtTok(E.estimate(cc.body)) + ' tok'));
          r.appendChild(m);
          r.addEventListener('click', function () { ctx.open('preset-custom-edit', { id: cc.id }); });
          cus.appendChild(r);
        });
        body.appendChild(cus);

        /* ---- 调试预览 ---- */
        var dbg = h('div', 'pp-sec');
        dbg.appendChild(h('p', 'pp-sec-title', '调试预览'));
        var pv = h('button', 'pp-row pp-row-active');
        pv.type = 'button';
        var pm = h('span', 'pp-row-main');
        pm.appendChild(h('span', 'pp-row-label', '打开预览'));
        pm.appendChild(h('span', 'pp-row-hint', '逐槽 tokens + 完整 prompt'));
        pv.appendChild(pm);
        pv.appendChild(h('span', 'pp-row-arrow', '›'));
        pv.addEventListener('click', function () { ctx.open('preset-preview', {}); });
        dbg.appendChild(pv);
        body.appendChild(dbg);

        if (!dev) {
          body.appendChild(h('p', 'pp-foot',
            '内置注入已上锁：能看到它存在，看不到内容。'));
        }
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ==================== 页面：单张卡 ==================== */

  Sleepy.register('preset-card', {
    title: '注入卡',
    render: function (ctx) {
      var E = engine();
      var body = ctx.body;
      var id = ctx.params.id || '';
      body.innerHTML = '';

      var def = null;
      E.onlineSlots.forEach(function (s) { if (s.id === id) def = s; });
      /* 不在线上矩阵里的内置卡（f2 / summary / proactive）：都已实装，
         由线下页 / 总结引擎 / 主动消息引擎在背后调用。 */
      if (!def) {
        var preMeta = E.cardMeta(id);
        if (preMeta) {
          var BACKDROP = {
            f2: { slot: 'C04', note: '线下模式每轮回复注入这张卡（prompt-engine.assembleOffline）。' },
            summary: { slot: '调用时注入', note: '总结引擎（线上累计 + 线下大总结）调用时注入这张卡。' },
            proactive: { slot: '调用时注入', note: '主动消息引擎评估时注入这张卡。' }
          };
          var bd = BACKDROP[id] || { slot: '—', note: '' };
          def = { id: id, slot: bd.slot, name: preMeta.title, kind: 'card',
                  required: true, note: bd.note };
        }
      }
      if (!def) { ctx.back(); return; }
      var meta = E.cardMeta(id);
      var isCard = def.kind === 'card';
      var locked = !!(meta && meta.locked) && !E.isDev();

      ctx.setTitle(def.name);

      /* 头部说明 */
      var head = h('div', 'pp-sec');
      head.appendChild(h('p', 'pp-sec-title', def.slot + ' · ' + (def.required ? 'required' : 'conditional')));
      if (def.note) head.appendChild(h('p', 'pp-sec-note', def.note));
      body.appendChild(head);

      if (!isCard) {
        /* program 槽：内容是装配时算出来的，没有卡可编辑 */
        head.appendChild(h('p', 'pp-plain',
          '这一槽由程序在每轮装配时生成（来源：' +
          (id === 'character' ? '角色卡的设定原文' :
           id === 'usercore' ? 'user 马甲的一句话人设' :
           id === 'i01' ? '当前对话的大小号与认知设定' :
           id === 'relation' ? '记忆认知层（[U→C] 归档）' :
           id === 'worldbook' ? '世界书（常驻条目 + 关键词命中的条目）' :
           id === 'drop' ? '掉马事件队列' :
           id === 'stickers' ? '表情包库存' :
           id === 'heartbeat' ? '心声开关' : '程序') + '）。' +
          '要看它实际长什么样，用调试预览。'));
        return;
      }

      if (locked) {
        head.appendChild(h('p', 'pp-locked', 'Sleepy 内置注入 · 内容不可见'));
        head.appendChild(h('p', 'pp-plain',
          '约 ' + fmtTok(E.estimate(E.cardBody(id))) + ' tokens，随每轮对话注入。'));
        return;
      }

      /* 开关（required 卡不可关） */
      if (!def.required) {
        var sw = ui.switchField({
          label: '注入这张卡',
          value: E.cardEnabled(id)
        });
        sw.input.addEventListener('change', function () {
          E.setCardEnabled(id, sw.get());
          ctx.toast(sw.get() ? '已启用' : '已停用', 'ok');
        });
        body.appendChild(sw.el);
      }

      /* 正文编辑 */
      var ta = ui.textArea({
        label: (meta && meta.locked) ? '内置文案（开发者模式）' : '卡正文',
        hint: '改动只存本机，可随时恢复默认',
        value: E.cardBody(id),
        rows: 16,
        counter: true
      });
      body.appendChild(ta.el);

      var row = h('div', 'btn-row');
      if (E.isOverridden(id)) {
        var reset = ui.button('恢复默认', '', function () {
          E.resetCard(id);
          /* 同参 open 不会重渲染，直接把文本框刷回默认值 */
          ta.input.value = E.cardBody(id);
          if (ta.input.dispatchEvent) ta.input.dispatchEvent(new Event('input'));
          ctx.toast('已恢复默认', 'ok');
        });
        row.appendChild(reset);
      }
      var save = ui.button('保存', 'primary', function () {
        E.saveCardBody(id, ta.get());
        ctx.toast('已保存', 'ok');
      });
      row.appendChild(save);
      body.appendChild(row);

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { save.click(); } }]);
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ==================== 页面：自定义注入编辑 ==================== */

  Sleepy.register('preset-custom-edit', {
    title: '自定义注入',
    render: function (ctx) {
      var E = engine();
      var body = ctx.body;
      body.innerHTML = '';
      var id = ctx.params.id || '';
      var existing = null;
      if (id) {
        E.customCards().forEach(function (c) { if (c.id === id) existing = c; });
        if (!existing) { ctx.back(); return; }
      }

      var fTitle = ui.textField({
        label: '标题',
        value: existing ? existing.title : '',
        placeholder: '比如：我们的约定'
      });
      body.appendChild(fTitle.el);

      var fBody = ui.textArea({
        label: '正文',
        hint: '会作为一条 system 注入插在关系记忆之后、输出协议之前',
        value: existing ? existing.body : '',
        rows: 12,
        counter: true
      });
      body.appendChild(fBody.el);

      var row = h('div', 'btn-row');
      if (existing) {
        var del = ui.button('删除', 'danger', function () {
          ui.confirm({
            title: '删掉「' + existing.title + '」？',
            ok: '删除', danger: true
          }).then(function (yes) {
            if (!yes) return;
            E.removeCustomCard(existing.id);
            ctx.toast('已删除', 'ok');
            ctx.back();
          });
        });
        row.appendChild(del);
      }
      var save = ui.button('保存', 'primary', function () {
        var title = fTitle.get() || '未命名注入';
        var text = fBody.get();
        if (!text.trim()) { ctx.toast('正文是空的', 'warn'); return; }
        if (existing) E.saveCustomCard(existing.id, { title: title, body: text });
        else E.addCustomCard(title, text);
        ctx.toast('已保存', 'ok');
        ctx.back();
      });
      row.appendChild(save);
      body.appendChild(row);

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { save.click(); } }]);
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ==================== 页面：调试预览 ==================== */

  Sleepy.register('preset-preview', {
    title: '调试预览',
    render: function (ctx) {
      var E = engine();
      var body = ctx.body;
      body.innerHTML = '';

      /* 模式切换：线上对话 / 线下场景（线下走 assembleOffline） */
      var modeRow = h('div', 'pp-mode-row');
      var mode = 'online';
      var bOn = h('button', 'pp-mode-btn active', '线上对话');
      var bOff = h('button', 'pp-mode-btn', '线下场景');
      bOn.type = bOff.type = 'button';
      modeRow.appendChild(bOn);
      modeRow.appendChild(bOff);
      body.appendChild(modeRow);

      var sel = h('select', 'pp-select');
      body.appendChild(sel);

      var sumBox = h('div', 'pp-sum');
      var out = h('pre', 'pp-pre');
      body.appendChild(sumBox);
      body.appendChild(out);

      function fillOptions() {
        sel.innerHTML = '';
        if (mode === 'online') {
          var chats = (Sleepy.chatStore ? Sleepy.chatStore.getChats() : []) || [];
          sel.appendChild(h('option', '', chats.length ? '选一个对话…' : '（还没有对话）'));
          chats.forEach(function (c) {
            var name = c.name || '对话';
            try {
              var ch = Sleepy.core.findChar(c.characterId);
              if (ch && ch.name) name = ch.name + ' · ' + name;
            } catch (e) { /* 名字拿不到就只用标题 */ }
            var o = h('option', '', name);
            o.value = c.id;
            sel.appendChild(o);
          });
        } else {
          var sess = (Sleepy.offlineStore ? Sleepy.offlineStore.allSessions() : []) || [];
          sel.appendChild(h('option', '', sess.length ? '选一个线下场景…' : '（还没有线下场景）'));
          sess.forEach(function (s) {
            var name = s.sceneName || '未命名场景';
            try {
              var ch2 = Sleepy.core.findChar(s.charId);
              if (ch2 && ch2.name) name = ch2.name + ' · ' + name;
            } catch (e) { /* 同上 */ }
            var o2 = h('option', '', name + '（' + (s.status === 'ended' ? '已结束' : s.status === 'paused' ? '暂停' : '进行中') + '）');
            o2.value = s.id;
            sel.appendChild(o2);
          });
        }
      }

      function setMode(m) {
        mode = m;
        bOn.classList.toggle('active', m === 'online');
        bOff.classList.toggle('active', m === 'offline');
        sumBox.innerHTML = '';
        out.textContent = '';
        fillOptions();
        run();
      }

      bOn.addEventListener('click', function () { setMode('online'); });
      bOff.addEventListener('click', function () { setMode('offline'); });

      function runOnline() {
        var chats = (Sleepy.chatStore ? Sleepy.chatStore.getChats() : []) || [];
        var cid = sel.value;
        var c = null;
        chats.forEach(function (x) { if (x.id === cid) c = x; });
        if (!c) return;

        /* 收历史：和 page-chat.buildMessages 同一套规则（只收 user/assistant，
           按对话设置的条数截尾）—— 这里是只读镜像，不改聊天页一行 */
        var ov = Sleepy.chatStore.overridesOf(c);
        var limit = (ov.contextMessages != null) ? ov.contextMessages
                  : (store.get('chatDefaults.contextMessages') || 20);
        var hist = [];
        (c.messages || []).forEach(function (m) {
          if (m.role !== 'user' && m.role !== 'assistant') return;
          var text = m.type ? (m.content || '') : (m.content || '');
          if (!text) return;
          hist.push({ role: m.role, content: text });
        });
        if (limit > 0 && hist.length > limit) hist = hist.slice(-limit);

        var r = E.assembleOnline({ charId: c.characterId, userId: c.userId, history: hist });
        var budget = E.budgetFor('online');
        render(r, budget, function (cb) {
          hist.forEach(function (m) {
            cb((m.role === 'user' ? 'user ▸ ' : 'char ▸ ') + m.content);
          });
        });
      }

      function runOffline() {
        var sess = (Sleepy.offlineStore ? Sleepy.offlineStore.allSessions() : []) || [];
        var sid = sel.value;
        var s = null;
        sess.forEach(function (x) { if (x.id === sid) s = x; });
        if (!s) return;

        /* userInput 传空：预览只看装配结构，不模拟用户输入 */
        var r = E.assembleOffline({ charId: s.charId, userId: null, session: s, userInput: '' });
        render(r, null, function (cb) {
          var charName = (Sleepy.core.findChar(s.charId) || {}).name || '他';
          (s.messages || []).slice(-20).forEach(function (m) {
            var text = '';
            if (m.role === 'user') text = 'user ▸ ' + (m.text || '');
            else if (m.role === 'scene') text = '【场景】' + (m.paras || []).map(function (p) { return p.text || ''; }).join('');
            else if (m.role === 'char') text = charName + ' ▸ ' + (m.paras || []).map(function (p) { return p.text || ''; }).join('');
            else if (m.role === 'photo') text = '（拍下了一张照片：' + (m.photoCaption || '') + '）';
            if (text) cb(text);
          });
          if (s.pendingSetup) cb('（这是 pendingSetup 会话：下一轮回复会顺带定场景）');
        });
      }

      function render(r, budget, historyLines) {
        sumBox.innerHTML = '';
        out.textContent = '';
        var total = 0;

        /* 槽位表 */
        var table = h('div', 'pp-sum-table');
        r.slots.forEach(function (s) {
          total += s.on ? s.tokens : 0;
          var line = h('div', 'pp-sum-line' + (s.on ? '' : ' is-off'));
          line.appendChild(h('span', 'pp-sum-slot', s.slot));
          line.appendChild(h('span', 'pp-sum-name', s.name + (s.on ? '' : ' · 未命中')));
          line.appendChild(h('span', 'pp-sum-tok', s.on ? ('≈' + fmtTok(s.tokens)) : '—'));
          table.appendChild(line);
        });
        sumBox.appendChild(table);

        var totalLine = h('p', 'pp-sum-total');
        totalLine.textContent = '合计 ≈' + total + ' tok（估算）';
        if (budget) {
          if (total > budget.max) totalLine.classList.add('is-over');
          else if (total > budget.target[1]) totalLine.classList.add('is-warn');
          else totalLine.classList.add('is-ok');
        }
        sumBox.appendChild(totalLine);

        /* 完整 prompt：每段前标槽位。正文一律 textContent，不吃注入。 */
        var lines = [];
        var idx = 0;
        r.slots.forEach(function (s) {
          if (!s.on || s.id === 'history') return;
          var msg = r.messages[idx];
          idx++;
          lines.push('┌──── [' + s.slot + '] ' + s.name + ' ────');
          lines.push(msg ? msg.content : '');
          lines.push('');
        });
        lines.push('┌──── [K09+U01] 近期原文 + 当前输入 ────');
        historyLines(function (l) { lines.push(l); });
        out.textContent = lines.join('\n');
      }

      function run() { if (mode === 'online') runOnline(); else runOffline(); }
      sel.addEventListener('change', run);
      fillOptions();
      run();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

})(window);
