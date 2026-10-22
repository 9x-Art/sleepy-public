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

        /* 2026-10-07 用户：内置上锁卡**直接点不进二级页** —— 点进去也看不了
           编辑不了，没意义。列表里拦住，弹个 toast 说明（开发者模式不受限）。 */
        function openCard(id) {
          var meta = E.cardMeta(id);
          if (meta && meta.locked && !E.isDev()) {
            ctx.toast('这张是内置卡，已上锁', 'warn');
            return;
          }
          ctx.open('preset-card', { id: id });
        }

        /* ---- 调用类型（方案-预设页分类与自察-v1 A，2026-10-21）----
           非开发者：只显示名字，不可点开、不加解释（用户口径「分类之后上锁，
           不加解释」）。开发者：照旧可点进卡、带 token 数。 */
        var types = h('div', 'pp-sec');
        types.appendChild(h('p', 'pp-sec-title', '调用类型'));
        [
          { id: 'f1', name: '线上普通回复' },
          { id: 'f2', name: '线下普通回复' },
          { id: 'summary', name: '总结' },
          { id: 'proactive', name: '主动消息' },
          { id: 'groupRound', name: '群聊一轮编排' }
        ].forEach(function (t) {
          var r = h(dev ? 'button' : 'div', 'pp-row' + (dev ? ' pp-row-active' : ''));
          if (dev) r.type = 'button';
          var m = h('span', 'pp-row-main');
          m.appendChild(h('span', 'pp-row-label', t.name));
          r.appendChild(m);
          if (dev) {
            r.appendChild(h('span', 'pp-row-tok', '≈' + fmtTok(E.estimate(E.cardBody(t.id)))));
            r.addEventListener('click', function () {
              global.scrollTo(0, 0);
              openCard(t.id);
            });
          }
          types.appendChild(r);
        });
        body.appendChild(types);

        /* ---- 线上提示词 / 角色功能（按 slotCat 分组，唯一出处 prompt-engine）----
           非开发者：名字即全部；角色功能卡的开不开是「功能取舍」不是
           「内容泄露」，所以开关保留在行内（2026-10-21 用户确认）。 */
        function catSec(title, cat) {
          var sec = h('div', 'pp-sec');
          sec.appendChild(h('p', 'pp-sec-title', title));
          E.onlineSlots.forEach(function (def) {
            if (def.id === 'custom' || def.id === 'history') return;
            if (E.slotCat(def.id) !== cat) return;
            var isCard = def.kind === 'card';
            var r = h(dev && isCard ? 'button' : 'div',
              'pp-row' + (dev && isCard && !E.cardEnabled(def.id) ? ' is-off' : ''));
            if (dev && isCard) r.type = 'button';
            var m = h('span', 'pp-row-main');
            m.appendChild(h('span', 'pp-row-label', def.name));
            r.appendChild(m);
            if (dev && isCard) {
              var toks = E.estimate(E.cardBody(def.id));
              if (toks) r.appendChild(h('span', 'pp-row-tok', '≈' + fmtTok(toks)));
              if (!def.required) r.appendChild(h('span', 'pp-row-req', '可选'));
              r.addEventListener('click', function () {
                global.scrollTo(0, 0);
                openCard(def.id);
              });
            }
            if (cat === 'feature' && isCard && !def.required) {
              var sw = h('label', 'set-switch pp-row-sw');
              var cb = h('input'); cb.type = 'checkbox'; cb.checked = E.cardEnabled(def.id);
              sw.appendChild(cb);
              sw.appendChild(h('span', 'set-switch-track'));
              sw.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var next = !E.cardEnabled(def.id);
                E.setCardEnabled(def.id, next);
                if (dev) r.classList[next ? 'remove' : 'add']('is-off');
                ctx.toast(next ? '已启用' : '已停用', 'ok');
              });
              r.appendChild(sw);
            }
            sec.appendChild(r);
          });
          body.appendChild(sec);
        }
        catSec('线上提示词', 'prompt');
        catSec('角色功能', 'feature');

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
        /* 顺序 = 注入顺序（方案-预设页分类与自察-v1 B，2026-10-21）：
           cfg().custom 数组序即线上/线下装配序，↑↓ 直接重排数组、立即落库生效。
           箭头用 span（button 套 button 不合法），点击要挡住冒泡别进编辑页。 */
        E.customCards().forEach(function (cc, ci) {
          var enabled = E.cardEnabled(cc.id);
          var r = h('button', 'pp-row' + (enabled ? '' : ' is-off'));
          r.type = 'button';
          var m = h('span', 'pp-row-main');
          m.appendChild(h('span', 'pp-row-label', cc.title));
          r.appendChild(m);
          var up = h('span', 'pp-row-move' + (ci === 0 ? ' is-dis' : ''), '↑');
          up.addEventListener('click', function (e) {
            e.stopPropagation();
            if (ci === 0) return;
            E.moveCustomCard(cc.id, -1);
            build();
          });
          var down = h('span', 'pp-row-move' + (ci === E.customCards().length - 1 ? ' is-dis' : ''), '↓');
          down.addEventListener('click', function (e) {
            e.stopPropagation();
            if (ci === E.customCards().length - 1) return;
            E.moveCustomCard(cc.id, 1);
            build();
          });
          r.appendChild(up);
          r.appendChild(down);
          r.appendChild(h('span', 'pp-row-tok', '≈' + fmtTok(E.estimate(cc.body)) + ' tok'));
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
        pv.appendChild(pm);
        pv.appendChild(h('span', 'pp-row-arrow', '›'));
        pv.addEventListener('click', function () { ctx.open('preset-preview', {}); });
        dbg.appendChild(pv);

        /* 自察开关（方案-预设页分类与自察-v1 C2，2026-10-21，默认关）：
           开着时 TA 每轮正文前先交一段 [自察]（本轮用了哪些设定条目、
           改了什么话），parseReply 剥出去、不进气泡不回喂；长按回复可看。 */
        var inspSw = ui.switchField({
          label: '让 TA 汇报用了哪些设定',
          hint: '开着：TA 回复前先写一段 [自察]，长按 TA 的回复可看。每轮多几十 tokens',
          value: E.inspectEnabled()
        });
        inspSw.input.addEventListener('change', function () {
          E.setInspect(inspSw.get());
          ctx.toast(inspSw.get() ? '下一轮回复开始带自察' : '已关掉', 'ok');
        });
        dbg.appendChild(inspSw.el);
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

      /* 群聊可用（2026-10-05 K03f）：默认关 = 私聊专属。开着的卡才会被
         群线上装配接走 —— 全群模型都看得见，别把只对某个角色有意义、
         或者带私密设定的卡放进群。 */
      var fGroup = ui.switchField({
        label: '群聊可用',
        hint: '开着 = 这张卡也会注入群聊（全群可见）。私聊专属、或只对某一个角色有意义的卡保持关闭。',
        value: !!(existing && existing.group)
      });
      body.appendChild(fGroup.el);

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
        if (existing) E.saveCustomCard(existing.id, { title: title, body: text, group: fGroup.get() });
        else E.addCustomCard(title, text, { group: fGroup.get() });
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
           按对话设置的条数截尾）—— 这里是只读镜像，不改聊天页一行。
           条数的回落规则也走同一份出口，别各写一遍（见 api.js contextLimit）。 */
        var limit = Sleepy.api.contextLimit(c);
        var hist = [];
        (c.messages || []).forEach(function (m) {
          if (m.role !== 'user' && m.role !== 'assistant') return;
          var text = m.type ? (m.content || '') : (m.content || '');
          if (!text) return;
          hist.push({ role: m.role, content: text, at: m.timestamp });   /* at：装配层渲染行内时间戳（与 page-chat 同口径） */
        });
        if (limit > 0 && hist.length > limit) hist = hist.slice(-limit);

        var r = E.assembleOnline({ charId: c.characterId, userId: c.userId, history: hist });
        var budget = E.budgetFor('online');
        /* 本轮命中（方案-预设页分类与自察-v1 C1）：世界书条目级命中清单，
           与装配同一个实现（worldbookHitList），只读展示，零新增调用。 */
        var wbHits = E.worldbookHitList
          ? E.worldbookHitList(c.characterId, hist.map(function (m) { return m.content || ''; }).join('\n').slice(-4000))
          : [];
        render(r, budget, function (cb) {
          hist.forEach(function (m) {
            cb((m.role === 'user' ? 'user ▸ ' : 'char ▸ ') + m.content);
          });
        }, wbHits);
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

      function render(r, budget, historyLines, wbHits) {
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

        /* 本轮命中（C1，2026-10-21）：只报线上模式；世界书没配/没命中
           就一句空态，不装神秘 —— 用户要的是「条目到底进没进这轮」。 */
        if (wbHits) {
          var hitLine = h('p', 'pp-sum-total');
          hitLine.textContent = wbHits.length
            ? ('本轮世界书命中 ' + wbHits.length + ' 条：' +
               wbHits.map(function (w) { return w.name + '（' + w.why + '）'; }).join('、'))
            : '本轮世界书没有命中任何条目（常驻与关键词都没打中）。';
          sumBox.appendChild(hitLine);
        }

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
