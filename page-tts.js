/* ============================================================
   page-tts.js — 语音 TTS 的三个页面
   依赖：store.js、ui.js、tts.js、media.js（必须在它们之后加载）
   页面：
     settings-tts          语音 TTS（服务列表 · 默认生成设置 · 帮助）
     settings-tts-provider 某家服务的连接详情（账户连接 / 验证 / 连接管理）
     char-voice            角色语音（单一 voiceState）

   依据：
     ·《全局设置 TTS 服务页 Demo v2》—— 服务列表 + 详情页的形；
       契约 §8 的 10 条修正**逐条落实**（初始未配置、不预填 Key、
       测试连接不伪造、默认模型可选择、MiniMax/ElevenLabs 只标「计划支持」、
       替换 Key 不谎称撤销、删默认服务不无条件回退 Fish、四档状态、不在普通配置里存 Key 明文）。
     · 契约 §9 的角色语音清单：模型受控选择、只列已实现服务、单一状态源、
       「最长语音」明说是 Sleepy 的筛选、试听要走真实链路。

   ---- 一条重要的取舍（与 tts.js 头注释呼应）----
   契约里「Key 不进入普通前端持久化」在纯静态项目里做不到（没有服务端、没有安全存储），
   用户 2026-09-22 拍板：**与主 API 同等对待**（存本地 + 进备份），
   但绝不进角色数据/聊天正文/记忆/日志。所以这里不假装有安全存储，
   只在帮助里把真实情况写清楚。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var tts = Sleepy.tts;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var textField = ui.textField;
  var numField = ui.numField;
  var textArea = ui.textArea;
  var switchField = ui.switchField;
  var button = ui.button;

  /* ---------------------------- 小工具 ---------------------------- */

  function statusKind(status) {
    return status === 'connected' ? 'ok'
      : (status === 'untested' ? 'wait' : (status === 'error' ? 'bad' : 'dim'));
  }

  /* 下拉字段：ui 里没有通用的 select 字段（生图/单份接口页也是自己搭的），
     这里做一份带 label + hint 的，三个页面共用。 */
  function selectField(label, hint, options, value, onChange) {
    var wrap = ui.fieldShell(label, hint);
    var sel = h('select', 'set-input set-select');
    options.forEach(function (o) {
      var opt = h('option', '', o.label);
      opt.value = o.id;
      if (String(o.id) === String(value == null ? '' : value)) opt.selected = true;
      sel.appendChild(opt);
    });
    wrap.appendChild(sel);
    ui.bindLabel(wrap, sel);
    if (onChange) sel.addEventListener('change', function () { onChange(sel.value); });
    return { el: wrap, select: sel, get: function () { return sel.value; } };
  }

  /* 多选胶囊（允许的情绪 / 表演标签）。点击即写，选中态是 .is-on。 */
  function chipField(label, hint, all, selected, onChange) {
    var wrap = h('div', 'set-field');
    wrap.appendChild(h('label', 'set-label', label));
    if (hint) wrap.appendChild(h('p', 'set-hint', hint));
    var box = h('div', 'tts-chips');
    var cur = selected.slice();
    all.forEach(function (item) {
      var b = h('button', 'tts-chip' + (cur.indexOf(item.id) >= 0 ? ' is-on' : ''),
        item.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        var i = cur.indexOf(item.id);
        if (i >= 0) cur.splice(i, 1); else cur.push(item.id);
        b.classList.toggle('is-on', i < 0);
        onChange(cur.slice());
      });
      box.appendChild(b);
    });
    wrap.appendChild(box);
    return { el: wrap, get: function () { return cur.slice(); } };
  }

  /* 播一段 blob（试听）。不放就走 <audio>，被系统拦了就留一个可点的播放键 ——
     契约 §9.12：自动播放失败必须回退成点击播放，不是静默失败。 */
  function playBlob(blob, host, ctx) {
    host.innerHTML = '';
    var url;
    try { url = global.URL.createObjectURL(blob); } catch (e) { url = ''; }
    if (!url) { host.appendChild(h('span', 'tts-play-note', '音频拿到了，但浏览器给不出播放地址')); return; }
    var audio = h('audio', 'tts-audio');
    audio.controls = true;
    audio.src = url;
    host.appendChild(audio);
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () {
        host.appendChild(h('p', 'tts-play-note is-warn',
          '系统拦住了自动播放 —— 点上面那个播放键就能听。'));
      });
    }
    audio.addEventListener('ended', function () {
      try { global.URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
    });
  }

  /* 实时链路试听：检查连接 → 语音导演 → Adapter 组装 → 请求 → 播放。
     **不写任何业务数据**，只把结果落在页面上（诊断区也用它）。 */
  function runSpeech(ctx, o, out) {
    out.innerHTML = '';
    out.appendChild(h('p', 'tts-play-note', '正在检查连接…'));
    var r = tts.resolveVoice(o.charId);
    if (!r.ok) {
      out.innerHTML = '';
      out.appendChild(h('p', 'tts-play-note is-bad', tts.normalizedError(r.code).userText));
      return;
    }
    var conn = o.conn || r.conn;
    var voiceId = o.voiceId || r.voiceId;
    var model = o.model || r.model;
    out.innerHTML = '';
    out.appendChild(h('p', 'tts-play-note', '正在生成…（' + (tts.providerOf(conn.provider).name) + ' · ' + model + '）'));
    /* 计划从哪来：调用方给了就用它；否则**先问导演**（模型版开着才真问，否则规则版自己算）。
       导演永远 resolve 一个能用的计划，拿不到就退回规则版 —— 所以这里不用做失败分支。 */
    var cfg = tts.voiceConfigOf(o.charId);
    var planOf = (o.plan || !Sleepy.ttsDirector)
      ? Promise.resolve(o.plan || tts.speechPlanOf(o.text, cfg, { manual: true }))
      : Sleepy.ttsDirector.planFor(o.text, cfg, {
        manual: true,
        context: o.context,
        features: tts.featuresOf(conn.provider, model),
        transport: o.directorTransport
      });
    planOf.then(function (plan) {
      return tts.generate({
        charId: o.charId,
        text: o.text,
        manual: true,
        transport: o.transport,
        plan: plan
      });
    }).then(function (res) {
      out.innerHTML = '';
      if (!res.ok) {
        out.appendChild(h('p', 'tts-play-note is-bad',
          (res.error && res.error.userText) || '生成失败'));
        if (res.error && res.error.status) {
          out.appendChild(h('p', 'tts-play-note',
            'HTTP ' + res.error.status + ' · ' + res.error.code));
        }
        return;
      }
      playBlob(res.blob, out, ctx);
      if (o.diag) {
        var d = h('div', 'tts-diag');
        /* Azure 的情绪不在标签里 —— 它在 SSML 的 express-as 风格里，单独说一句 */
        var st = tts.azureStyleOf && tts.azureStyleOf(res.voiceId || '', res.plan);
        var styleNote = st ? ('Azure 风格 ' + st.style + '(' + st.degree + ')') : '';
        d.appendChild(h('p', '', '服务商：' + tts.providerOf(res.provider).name + ' · ' + res.model));
        d.appendChild(h('p', '', '合成文本（**只给服务商看的临时文本**）：' + res.synthesisText));
        d.appendChild(h('p', '', '计划：' + res.plan.emotion + ' / 强度 ' + res.plan.intensity +
          ' / 克制 ' + res.plan.restraint + ' / 语速 ' + res.plan.pace +
          (res.plan.performanceTags.length ? ' / ' + res.plan.performanceTags.join(' ') : '') +
          ' / 停顿 ' + (res.plan.naturalPause === false ? '关' : '开') +
          (styleNote ? ' / ' + styleNote : '')));
        d.appendChild(h('p', '', '导演：' + (res.plan.source === 'model' ? '模型版' : '规则版') +
          (res.plan.directorNote ? '（' + res.plan.directorNote + '，已回退）' : '')));
        d.appendChild(h('p', '', '原因：' + res.plan.reason + ' · 原文字数 ' + o.text.length +
          ' 字 · 约 ' + (res.plan.seconds || 0) + ' 秒'));
        out.appendChild(d);
      }
    });
  }

  /* ==================== 页面：语音 TTS（服务列表） ==================== */

  Sleepy.register('settings-tts', {
    title: '语音 TTS',
    render: function (ctx) {
      var body = ctx.body;

      function build() {
        body.innerHTML = '';
        var s = tts.settings();

        body.appendChild(h('p', 'set-group-note',
          '在这里连接生成语音所需的服务。具体音色、语音频率和情绪表达，由每个角色单独设置。'));

        /* ---- 总开关 ---- */
        var gOn = group('语音', '关着的时候，任何角色都不会生成语音（手动朗读也不行）。');
        var sw = switchField({
          label: '开启语音',
          hint: '总开关 · 每件角色在「角色语音」里还有自己的开关',
          value: !!s.enabled
        });
        sw.input.addEventListener('change', function () {
          tts.saveSettings({ enabled: sw.get() });
          ctx.toast(sw.get() ? '语音已开启' : '语音已关闭', 'ok');
          build();
        });
        gOn.card.appendChild(sw.el);
        gOn.card.appendChild(row({
          label: '默认服务与模型',
          hint: '设哪条连接默认、默认用哪个档位',
          badge: s.defaultConnectionId ? (tts.connectionSummary(tts.connection(s.defaultConnectionId))) : '未选择',
          badgeKind: s.defaultConnectionId ? 'ok' : 'dim',
          onClick: function () { pickDefault(ctx, build); }
        }));
        body.appendChild(gOn.wrap);

        /* ---- 服务列表 ---- */
        var gSvc = group('语音服务', '只需要连接实际要用的服务，不要求同时注册所有家。');
        tts.PROVIDER_ORDER.forEach(function (pid) {
          var prov = tts.providerOf(pid);
          var conn = tts.firstConnectionOf(pid);
          gSvc.card.appendChild(row({
            label: prov.name,
            hint: prov.desc,
            value: conn ? (conn.displayName || prov.defaultName) : '',
            badge: tts.connectionSummary(conn),
            badgeKind: statusKind(conn ? conn.status : 'unconfigured'),
            onClick: function () { ctx.open('settings-tts-provider', { provider: pid }); }
          }));
        });
        body.appendChild(gSvc.wrap);
        body.appendChild(h('p', 'set-group-note',
          '全都是浏览器直连（这个 App 没有服务端）。Fish Audio 的接口在部分网络下连不上，' +
          '要代理或自建中转；MiniMax、硅基流动、Azure 国内可达；ElevenLabs 只有 v3 能带 Audio Tags。'));

        /* ---- 接不了的那些（连同实测原因一起摆出来）----
           契约 §8.6：没有 Adapter 一律不许显示成可用。但「灰着不说为什么」和
           「写清为什么」是两件事 —— 用户要的是后者（这样才知道该走中转还是死心）。 */
        var gNo = group('还不能直连的服务', '这些是探测过、现在接不了的；原因写在每一行下面。');
        tts.PROVIDER_PLANNED.forEach(function (pid) {
          var prov = tts.providerOf(pid);
          if (!prov) return;
          gNo.card.appendChild(row({
            label: prov.name,
            hint: prov.desc,
            badge: '未实现',
            badgeKind: 'dim'
          }));
        });
        gNo.card.appendChild(row({
          label: '用「自定义 · OpenAI 兼容」接它们',
          hint: '自己搭一个中转（或本地跑 GPT-SoVITS / fish-speech / one-api），把地址填进去就行',
          onClick: function () {
            var p = tts.providerOf('custom_openai');
            ui.confirm({
              title: '自定义 · OpenAI 兼容',
              note: '这条连接用于：自建的语音服务，或者你自己搭的中转。\n\n' +
                '它要求对方认 OpenAI 的 /v1/audio/speech（GPT-SoVITS、fish-speech、' +
                'openedai-speech、LocalAI、one-api 这些都能这么用）。\n\n' +
                '上面那些「还不能直连」的家，也都可以先转成这个形状再填进来。',
              ok: '去配一条'
            }).then(function (yes) {
              if (!yes) return;
              ctx.open('settings-tts-provider', { provider: 'custom_openai' });
            });
          }
        }));
        body.appendChild(gNo.wrap);

        /* ---- 默认生成设置（模型列表跟着默认服务的供应商走） ---- */
        var curConn = tts.connection(s.defaultConnectionId) || tts.firstConnectionOf(null);
        var gDef = group('默认生成设置', '角色之后仍可单独覆盖。');
        gDef.card.appendChild(selectField('默认模型', '换默认服务时记得回来看一眼这一项',
          tts.modelsOf(curConn ? curConn.provider : 'fish_audio').map(function (m) {
            return { id: m.id, label: m.label + (m.note ? '（' + m.note + '）' : '') };
          }), s.defaultModel, function (v) {
            tts.saveSettings({ defaultModel: v });
            ctx.toast('已更新默认语音模型', 'ok');
          }).el);
        /* 导演引擎（契约 §5）：规则版不出网；模型版多一次便宜调用，判得更准。
           出厂是规则版 —— 不给用户默认就多花 token。 */
        gDef.card.appendChild(selectField('导演引擎',
          '规则版：靠词典 + 标点 + 你的设置判断，不出网。' +
          '模型版：让模型读上下文判「这句该怎么念」，失败会自动退回规则版',
          [{ id: 'rules', label: '规则版（不出网）' }, { id: 'model', label: '模型版（用主模型判断）' }],
          s.director || 'rules', function (v) {
            tts.saveSettings({ director: v });
            ctx.toast(v === 'model' ? '情绪改由模型判断了' : '改回规则版', 'ok');
          }).el);

        /* 自动播放的全局默认：角色页可以选「跟随全局」，读的就是这一项。
           出厂「只在我点时播」—— 手机上突然出声很讨厌。 */
        gDef.card.appendChild(selectField('自动播放（默认）',
          '角色页里可以各自覆盖；系统拦截时一律回退成点击播放',
          [{ id: 'manual', label: '只在我点时播' }, { id: 'auto', label: '生成完自动播' }],
          s.autoPlay, function (v) {
            tts.saveSettings({ autoPlay: v });
            ctx.toast(v === 'auto' ? '生成完会自动播（可能被系统拦）' : '改成只在你点时播', 'ok');
          }).el);
        body.appendChild(gDef.wrap);
        body.appendChild(h('p', 'set-group-note',
          '免费开发档在繁忙时可能较慢；正式使用可以切到稳定生产档。'));

        /* ---- 帮助 ---- */
        var gHelp = group('帮助', '');
        gHelp.card.appendChild(row({
          label: '凭据与隐私说明',
          hint: 'API Key 存在哪、怎么替换、拆掉服务时会发生什么',
          onClick: function () { credentialNote(ctx); }
        }));
        gHelp.card.appendChild(row({
          label: '语音是怎么做出来的',
          hint: '原文 → 语音计划 → 临时合成文本 → 音频（标签绝不进聊天正文）',
          onClick: function () { pipelineNote(ctx); }
        }));
        body.appendChild(gHelp.wrap);
        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* 「默认服务与模型」：用一个选择弹层来选（连接是多条的时候比下拉清楚） */
  function pickDefault(ctx, done) {
    var list = tts.connections();
    if (!list.length) {
      ctx.toast('还没有任何连接 —— 先去下面连一家服务', 'warn');
      return;
    }
    ui.confirm({
      title: '默认用哪条连接',
      note: list.map(function (c, i) {
        return (i + 1) + '. ' + (tts.providerOf(c.provider) || {}).name + ' · ' +
          (c.displayName || '连接') + '（' + tts.connectionSummary(c) + '）';
      }).join('\n') + '\n\n在下面的输入框里填序号。',
      ok: '就它'
    }).then(function (yes) {
      if (!yes) return;
      ui.prompt({
        title: '填序号',
        note: '1 ~ ' + list.length,
        value: '1',
        ok: '设为默认'
      }).then(function (v) {
        var idx = parseInt(String(v || ''), 10);
        if (!idx || idx < 1 || idx > list.length) return;
        tts.saveSettings({ defaultConnectionId: list[idx - 1].id });
        /* 换供应商时默认模型会「牛唇不对马嘴」（存着 Fish 的档位、列表却是别人家的）——
           顺手把它换成这家第一条。用户之后还能自己改。 */
        var newConn = list[idx - 1];
        if (!tts.modelsOf(newConn.provider).some(function (m) { return m.id === tts.settings().defaultModel; })) {
          var first = tts.modelsOf(newConn.provider)[0];
          if (first) tts.saveSettings({ defaultModel: first.id });
        }
        ctx.toast('默认服务已更新', 'ok');
        if (done) done();
      });
    });
  }

  /* ==================== 页面：服务连接详情 ==================== */

  Sleepy.register('settings-tts-provider', {
    title: '语音服务',
    render: function (ctx) {
      var body = ctx.body;
      var providerId = ctx.params.provider || 'fish_audio';
      var prov = tts.providerOf(providerId);
      if (!prov) { ctx.toast('不认识这家语音服务', 'err'); ctx.back(); return; }

      /* 这家服务可能有**多条**连接（比如一个正式号一个测试号）。
         默认编辑第一条；「新建一条」在下面。 */
      var connId = ctx.params.connId || null;
      function connNow() {
        return connId ? tts.connection(connId) : tts.firstConnectionOf(providerId);
      }

      function build() {
        body.innerHTML = '';
        var c = connNow();
        ctx.setTitle(prov.name);

        var head = h('div', 'tts-prov-head');
        var top = h('div', 'tts-prov-top');
        top.appendChild(h('b', 'tts-prov-name', prov.name));
        var statusEl = h('span', 'set-badge set-badge-' +
          statusKind(c ? c.status : 'unconfigured'), tts.connectionSummary(c));
        top.appendChild(statusEl);
        head.appendChild(top);
        head.appendChild(h('p', 'tts-prov-desc',
          '用于生成角色语音。音色与表达习惯请在角色语音页里选。'));
        body.appendChild(head);
        /* 只刷状态胶囊，不整页重画。
           ⚠️ 早先测试完直接 build()，结果**把刚写出来的测试结果擦掉了**
           （结果是挂在旧 DOM 上的）。状态变化用这个，别用整页重画。 */
        function refreshHead() {
          var cc = tts.connection(c.id);
          if (!cc) return;
          statusEl.textContent = tts.connectionSummary(cc);
          statusEl.className = 'set-badge set-badge-' + statusKind(cc.status);
        }

        if (!c) {
          /* 还没有连接：先建一条（**不预填 Key**，契约 §8.2） */
          var gNew = group('还没有连接', '填好 Key 与接口地址，点「保存连接」。');
          var f0 = h('div', 'set-field');
          f0.appendChild(h('label', 'set-label', '连接名称'));
          var name0 = h('input', 'set-input');
          name0.placeholder = prov.defaultName;
          f0.appendChild(name0);
          ui.bindLabel(f0, name0);
          gNew.card.appendChild(f0);
          var acts0 = h('div', 'btn-row');
          acts0.appendChild(button('新建连接', 'primary', function () {
            var made = tts.saveConnection({
              provider: providerId,
              displayName: String(name0.value || '').trim() || prov.defaultName,
              endpoint: prov.endpoint
            });
            ctx.toast('建好了，接着填 Key', 'ok');
            connId = made.id;
            build();
          }));
          gNew.card.appendChild(acts0);
          body.appendChild(gNew.wrap);
          return;
        }

        /* ---- 账户连接 ---- */
        var gConn = group('账户连接', '');
        var fields = {};
        fields.name = textField({
          label: '连接名称',
          value: c.displayName || prov.defaultName,
          placeholder: prov.defaultName
        });
        gConn.card.appendChild(fields.name.el);

        var keyWrap = ui.fieldShell('API Key',
          /* 契约 §8.7：替换 Key 不谎称撤销后台旧 Key */
          '只存在这台设备上（跟主 API 一样）。替换后 Sleepy 立即停止使用旧 Key，' +
          '但服务商后台的旧 Key 还在 —— 要撤销请去控制台。');
        var keyBox = h('div', 'tts-key-box');
        var keyInput = h('input', 'set-input');
        keyInput.type = 'password';
        keyInput.autocomplete = 'new-password';
        keyInput.placeholder = c.apiKey ? '已保存；留空表示不替换' : '请输入服务商提供的 API Key';
        keyBox.appendChild(keyInput);
        var eye = h('button', 'tts-mini-btn', '显示');
        eye.type = 'button';
        eye.addEventListener('click', function () {
          var hidden = keyInput.type === 'password';
          keyInput.type = hidden ? 'text' : 'password';
          eye.textContent = hidden ? '隐藏' : '显示';
        });
        keyBox.appendChild(eye);
        keyWrap.appendChild(keyBox);
        gConn.card.appendChild(keyWrap);

        if (prov.freeModel) {
          /* 自建/中转的服务，模型名五花八门（sft / gpt-4o-mini-tts / 随便什么），
             只能让用户自由填 —— 它优先于全局默认模型（见 tts.resolveVoice）。 */
          fields.model = textField({
            label: '模型 ID',
            hint: '这个服务要的模型名（不知道就先留空，会用默认那条）· 例：tts-1 / sft / cosyvoice',
            value: c.model || '',
            placeholder: 'tts-1'
          });
          gConn.card.appendChild(fields.model.el);
        }

        fields.endpoint = textField({
          label: '接口地址',
          hint: providerId === 'elevenlabs'
            ? '普通用户保留默认即可。音色 ID 会拼在地址末尾；自建中转可以把 {voice_id} 写在地址里的任意位置'
            : '普通用户保留默认即可；用代理或自建中转时改这里',
          value: c.endpoint || prov.endpoint,
          placeholder: prov.endpoint,
          inputmode: 'url'
        });
        gConn.card.appendChild(fields.endpoint.el);

        fields.voiceId = textField({
          label: '测试用音色 ID',
          hint: prov.voiceHint + ' · 只用来测试连接，角色用哪个音色在「角色语音」里单独设',
          value: c.testVoiceId || '',
          placeholder: 'voice id'
        });
        gConn.card.appendChild(fields.voiceId.el);
        body.appendChild(gConn.wrap);

        var acts = h('div', 'btn-row');
        var testBtn = button('测试连接', 'ghost', function () { doTest(); });
        acts.appendChild(testBtn);
        acts.appendChild(button('保存连接', 'primary', function () { doSave(); }));
        body.appendChild(acts);

        var out = h('div', 'tts-result');
        body.appendChild(out);

        /* ---- 验证 ---- */
        var gTest = group('验证', '');
        gTest.card.appendChild(row({
          label: '测试语音生成',
          hint: '走完整链路：语音计划 → 组装 → 请求 → 播放',
          onClick: function () { doGenerate(); }
        }));
        gTest.card.appendChild(row({
          label: '打开服务商控制台',
          hint: '管理账户、余额、Key 与音色',
          onClick: function () {
            if (global.open) global.open(prov.consoleUrl, '_blank');
            else ctx.toast(prov.consoleUrl);
          }
        }));
        gTest.card.appendChild(row({
          label: '高级诊断',
          hint: '看脱敏后的语音计划与临时合成文本',
          onClick: function () { diag(ctx, providerId, c); }
        }));
        body.appendChild(gTest.wrap);

        /* ---- 连接管理 ---- */
        var gMgmt = group('连接管理', '');
        if (tts.connections().filter(function (x) { return x.provider === providerId; }).length > 1) {
          gMgmt.card.appendChild(row({
            label: '换一条连接',
            hint: '这家服务下有多条连接时在这里切换',
            onClick: function () { pickConnection(ctx, providerId); }
          }));
        }
        gMgmt.card.appendChild(row({
          label: '再建一条连接',
          hint: '比如正式号与测试号分开',
          onClick: function () {
            var made = tts.saveConnection({ provider: providerId, displayName: prov.defaultName + ' 2' });
            connId = made.id;
            build();
          }
        }));
        gMgmt.card.appendChild(row({
          label: '删除这条连接',
          hint: '用它的角色会收到明确的「连接不在了」，不会静默换声音',
          onClick: function () { doDelete(c); }
        }));
        body.appendChild(gMgmt.wrap);

        ctx.setActions([{ label: '保存连接', kind: 'primary', onClick: function () { doSave(); } }]);

        function doSave() {
          var key = String(keyInput.value || '').trim();
          var patch = {
            id: c.id,
            provider: providerId,
            displayName: String(fields.name.get() || '').trim() || prov.defaultName,
            endpoint: String(fields.endpoint.get() || '').trim() || prov.endpoint,
            testVoiceId: String(fields.voiceId.get() || '').trim()
          };
          if (key) patch.apiKey = key;   /* 留空 = 不替换 */
          tts.saveConnection(patch);
          ctx.toast(key ? '已保存，等真实服务验证' : '已保存', 'ok');
          connId = c.id;
          build();
        }

        function doTest() {
          var key = String(keyInput.value || '').trim();
          if (providerId === 'custom_openai' && !String(fields.endpoint.get() || '').trim()) {
            showOut(out, false, '先填接口地址 —— 自定义服务没有官方地址可以回落。');
            return;
          }
          var nameNow = String(fields.name.get() || '').trim() || prov.defaultName;
          var epNow = String(fields.endpoint.get() || '').trim() || prov.endpoint;
          var voiceNow = String(fields.voiceId.get() || '').trim();
          var cfg = {
            id: c.id,
            provider: providerId,
            model: fields.model ? String(fields.model.get() || '').trim() : c.model,
            endpoint: epNow,
            apiKey: key || c.apiKey,
            displayName: nameNow,
            testVoiceId: voiceNow
          };
          if (!cfg.apiKey) {
            showOut(out, false, '先填 API Key，再测试连接。');
            return;
          }
          if (!cfg.testVoiceId) {
            showOut(out, false, '测试连接需要先填一个音色 ID（服务商那边没有纯「ping」接口）。');
            return;
          }
          /* 把非密字段先落盘：测试可能失败、用户可能直接离开这一页，
             填过的音色 ID 不该丢（丢了下次又得重填一遍）。Key 也顺手存。 */
          tts.saveConnection({
            id: c.id, provider: providerId, displayName: nameNow,
            endpoint: epNow, testVoiceId: voiceNow, apiKey: cfg.apiKey
          });
          showOut(out, null, '正在测试…（' + prov.name + '）');
          tts.testConnection(cfg, cfg.testVoiceId).then(function (r) {
            if (r.ok) {
              /* 只有**真实成功**才写 connected（契约 §11.3） */
              tts.markConnection(c.id, 'connected');
              showOut(out, true, '连接成功 · 拿回 ' + r.bytes + ' 字节音频' +
                (r.requestId ? ' · request ' + String(r.requestId).slice(0, 12) : '') +
                '（Key ' + tts.maskKey(cfg.apiKey) + '）');
            } else {
              tts.markConnection(c.id, 'error', { code: r.error.code });
              showOut(out, false, r.error.userText + '（' + r.error.code +
                (r.error.status ? ' · HTTP ' + r.error.status : '') + '）');
            }
            refreshHead();   /* 只刷状态胶囊，别整页重画（会擦掉结果） */
          });
        }

        function doGenerate() {
          var key = String(keyInput.value || '').trim();
          var cfg = {
            id: c.id, provider: providerId,
            endpoint: String(fields.endpoint.get() || '').trim() || prov.endpoint,
            apiKey: key || c.apiKey,
            testVoiceId: String(fields.voiceId.get() || '').trim()
          };
          if (!cfg.apiKey || !cfg.testVoiceId) {
            showOut(out, false, '生成需要 API Key + 音色 ID。');
            return;
          }
          showOut(out, null, '正在生成…');
          /* 走**同一条** tts.generate（只是显式给连接，不经过角色的配置）——
             这样设置页的测试和聊天里的正式生成不会出现两套组装逻辑。 */
          tts.generate({
            conn: cfg,
            model: tts.settings().defaultModel,
            voiceId: cfg.testVoiceId,
            text: '你好，这是一次测试。今天过得怎么样？',
            manual: true
          }).then(function (res) {
            out.innerHTML = '';
            if (!res.ok) {
              out.appendChild(h('p', 'tts-play-note is-bad',
                (res.error && res.error.userText) || '生成失败'));
              if (res.error && res.error.status) {
                out.appendChild(h('p', 'tts-play-note',
                  'HTTP ' + res.error.status + ' · ' + res.error.code));
              }
              return;
            }
            playBlob(res.blob, out, ctx);
            out.appendChild(h('p', 'tts-play-note',
              '临时合成文本：' + (res.synthesisText || '') +
              ' · ' + res.blob.size + ' 字节'));
          });
        }

        function doDelete(c) {
          ui.confirm({
            title: '删除「' + (c.displayName || prov.name) + '」这条连接？',
            note: '用它的角色会拿到明确的「连接不在了」提示，不会静默换一个声音。' +
              '服务商后台的 Key 不会被撤销（那得去控制台）。',
            ok: '删除',
            danger: true
          }).then(function (yes) {
            if (!yes) return;
            var r = tts.removeConnection(c.id);
            ctx.toast(r.fallbackTo ? '已删除；默认服务换成了另一条连接' : '已删除', 'ok');
            connId = null;
            build();
          });
        }

        function showOut(host, ok, text) {
          host.innerHTML = '';
          var p = h('div', 'tts-result-box' + (ok === null ? '' : (ok ? ' is-ok' : ' is-bad')));
          p.appendChild(h('span', 'tts-result-dot'));
          p.appendChild(h('span', '', text));
          host.appendChild(p);
        }
      }

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ==================== 页面：角色语音 ==================== */

  Sleepy.register('char-voice', {
    title: '角色语音',
    render: function (ctx) {
      var body = ctx.body;
      var charId = ctx.params.charId || '';
      var ch = Sleepy.core ? Sleepy.core.findChar(charId) : null;
      if (!charId || !ch) { ctx.toast('找不到这个角色', 'err'); ctx.back(); return; }

      /* ---- 单一状态源（契约 §9.6）----
         `state` 是这一页唯一的事实；控件读它、写它，页面重画也读它。
         没有单独设置过（charVoice.byChar 里没有这件）时，页面显示的是**出厂默认**，
         并且所有控件是只读的 —— 避免「碰一下就被钉住、以后不跟全局」的暗坑。 */
      var own = tts.hasOwnVoice(charId);
      var state = tts.voiceConfigOf(charId);
      var overridden = own;

      function persist(patch) {
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
        tts.saveVoice(charId, patch);
      }

      function build() {
        body.innerHTML = '';
        ctx.setTitle(ch.name + ' 的声音');
        own = tts.hasOwnVoice(charId);
        overridden = own;
        state = tts.voiceConfigOf(charId);

        /* ---- 头 ---- */
        var head = h('div', 'tts-prov-head');
        var top = h('div', 'tts-prov-top');
        top.appendChild(h('b', 'tts-prov-name', ch.name + ' 的声音'));
        top.appendChild(h('span', 'set-badge set-badge-' +
          (state.enabled ? 'ok' : 'dim'), state.enabled ? '已开启' : '未开启'));
        head.appendChild(top);
        head.appendChild(h('p', 'tts-prov-desc',
          own ? '这件角色有自己的一套语音设置。'
            : '现在跟随默认（出厂）设置。想让 TA 和其他角色不一样，点下面的「单独设置」。'));
        body.appendChild(head);

        if (!tts.settings().enabled) {
          body.appendChild(h('p', 'tts-warn-note',
            '语音总开关还关着 —— 先去「设置 → 语音 TTS → 开启语音」。'));
        }

        /* ---- 启用 + 单独设置 ---- */
        var gOn = group('这件角色的语音', '');
        var sw = switchField({
          label: '给 TA 生成语音',
          hint: '关着的时候，TA 的回复不会有语音',
          value: !!state.enabled
        });
        sw.input.addEventListener('change', function () {
          if (!own) tts.saveVoice(charId, {});   /* 先落一件，后续改动才有地方存 */
          persist({ enabled: sw.get() });
          build();
        });
        gOn.card.appendChild(sw.el);

        if (!own) {
          gOn.card.appendChild(row({
            label: '单独设置',
            hint: '把这件角色的音色 / 频率 / 表达单独定一套（之后不再跟着默认走）',
            onClick: function () {
              tts.saveVoice(charId, { enabled: state.enabled, voiceId: state.voiceId });
              ctx.toast('现在可以单独设置了', 'ok');
              build();
            }
          }));
        } else {
          gOn.card.appendChild(row({
            label: '恢复跟随默认',
            hint: '丢掉这件角色自己的设置（音色、频率、表达全部回到默认）',
            onClick: function () {
              ui.confirm({
                title: '让「' + ch.name + '」恢复跟随默认？',
                note: '这件角色自己的语音设置会被丢掉。',
                ok: '恢复',
                danger: true
              }).then(function (yes) {
                if (!yes) return;
                var all = tts.voiceAll();
                delete all.byChar[charId];
                store.set('charVoice', all);
                ctx.toast('已恢复跟随默认', 'ok');
                build();
              });
            }
          }));
        }
        body.appendChild(gOn.wrap);

        /* 单独设置之前，下面的字段只读（点了给提示，不写数据） */
        var ro = !own;
        function guard(fn) {
          return function () {
            if (ro) { ctx.toast('先点「单独设置」', 'warn'); return; }
            fn();
          };
        }

        /* ---- 服务与模型 ---- */
        var gConn = group('用哪条服务与模型', '');
        var connOpts = [
          { id: '', label: '跟随默认服务' }
        ].concat(tts.connections().map(function (c) {
          return { id: c.id, label: (tts.providerOf(c.provider) || {}).name + ' · ' + (c.displayName || '连接') };
        }));
        var selConn = selectField('服务连接', '', connOpts,
          state.connectionMode === 'override' ? (state.connectionId || '') : '', function (v) {
            if (ro) { ctx.toast('先点「单独设置」', 'warn'); selConn.select.value = ''; return; }
            persist(v ? { connectionMode: 'override', connectionId: v } : { connectionMode: 'global', connectionId: null });
            build();
          });
        if (ro) selConn.select.disabled = true;
        gConn.card.appendChild(selConn.el);

        var useConn = state.connectionMode === 'override' && state.connectionId
          ? tts.connection(state.connectionId)
          : (tts.connection(tts.settings().defaultConnectionId) || tts.connections()[0]);
        var modelOpts = [{ id: '', label: '跟随默认模型' }].concat(
          tts.modelsOf(useConn ? useConn.provider : 'fish_audio').map(function (m) {
            return { id: m.id, label: m.label + (tts.capabilitiesOf(useConn ? useConn.provider : 'fish_audio', m.id).performanceTags ? '' : ' · 无表演标签') };
          }));
        /* 连接上填过模型（自定义/中转那种）时，把它也列进来 ——
           否则下拉里显示的和你实际会用的不是同一个，看着像 bug。 */
        if (useConn && useConn.model && !modelOpts.some(function (o) { return o.id === useConn.model; })) {
          modelOpts.splice(1, 0, { id: useConn.model, label: useConn.model + '（连接里填的）' });
        }
        var selModel = selectField('模型', '', modelOpts,
          state.modelMode === 'override' ? (state.model || '') : '', function (v) {
            if (ro) { ctx.toast('先点「单独设置」', 'warn'); selModel.select.value = ''; return; }
            persist(v ? { modelMode: 'override', model: v } : { modelMode: 'global', model: '' });
            build();
          });
        if (ro) selModel.select.disabled = true;
        gConn.card.appendChild(selModel.el);

        var fVoice = textField({
          label: '音色 ID',
          hint: useConn ? (tts.providerOf(useConn.provider).voiceHint || '') : '先去设置里连一条服务',
          value: state.voiceId || '',
          placeholder: 'voice id'
        });
        if (ro) { fVoice.input.disabled = true; }
        else {
          fVoice.input.addEventListener('input', function () { persist({ voiceId: String(fVoice.get() || '').trim() }); });
        }
        gConn.card.appendChild(fVoice.el);
        body.appendChild(gConn.wrap);

        /* ---- 什么时候读 ---- */
        var gWhen = group('什么时候读', '');
        var fFreq = selectField('主动语音频率', '你点「朗读」时不受这里限制',
          tts.FREQUENCIES.map(function (f) { return { id: f.id, label: f.label + ' · ' + f.hint }; }),
          state.frequency, function (v) {
            if (ro) { ctx.toast('先点「单独设置」', 'warn'); return; }
            persist({ frequency: v });
          });
        if (ro) fFreq.select.disabled = true;
        gWhen.card.appendChild(fFreq.el);

        var fMax = selectField('单轮最多几条', '', [
          { id: '1', label: '1 条' }, { id: '2', label: '2 条' }
        ], String(state.maxPerTurn), function (v) {
          if (ro) return; persist({ maxPerTurn: Number(v) || 1 });
        });
        if (ro) fMax.select.disabled = true;
        gWhen.card.appendChild(fMax.el);

        var fCool = selectField('冷却轮次', '刚读过之后，几轮之内不再主动读',
          [1, 2, 3, 5].map(function (n) { return { id: String(n), label: n + ' 轮' }; }),
          String(state.cooldownTurns), function (v) {
            if (ro) return; persist({ cooldownTurns: Number(v) || 2 });
          });
        if (ro) fCool.select.disabled = true;
        gWhen.card.appendChild(fCool.el);

        var fSec = selectField('最长语音', '**Sleepy 侧的筛选规则**：超过就不生成（不是服务商参数）',
          [15, 30, 60].map(function (n) { return { id: String(n), label: n + ' 秒内' }; }),
          String(state.maxSeconds), function (v) {
            if (ro) return; persist({ maxSeconds: Number(v) || 30 });
          });
        if (ro) fSec.select.disabled = true;
        gWhen.card.appendChild(fSec.el);
        body.appendChild(gWhen.wrap);

        /* ---- 怎么读 ---- */
        /* 每家的接口不一样（用户：「每个接口不一样要分别设置」）——
           所以先算清**这条连接**能接哪些控制，界面照实标出来，别让用户以为设了就一定生效。 */
        var useModel = (state.modelMode === 'override' && state.model)
          ? state.model
          : ((useConn && useConn.model) || tts.settings().defaultModel || '');
        var feat = useConn ? tts.featuresOf(useConn.provider, useModel) : null;
        var featLine = feat
          ? ('\n当前连接（' + (tts.providerOf(useConn.provider) || {}).name + '）能接的：' +
            '情绪 → ' + feat.emoLabel + '；语速 → ' + (feat.speed ? '能调' : '这家不支持') +
            '；停顿 → ' + (feat.pause ? '能插标记' : '这家没有停顿字段'))
          : '';
        featLine += (tts.settings().director === 'model')
          ? '\n导演引擎：模型版（在「设置 → 语音 TTS」里改）—— 多一次调用判情绪，失败自动退回规则版。'
          : '\n导演引擎：规则版（设置里可切成模型版，判断更准）。';
        var gHow = group('怎么读',
          '这三项都会进「语音计划」：语速按服务商的韵律字段发出去（Azure 是 SSML 的 prosody），' +
          '情绪幅度决定标签/风格的强度，克制度则优先**减标签**而不是加一句「克制」。' + featLine);
        var fPace = numField({
          label: '语速（70–130，100 是正常）' + (feat && !feat.speed ? ' · 这家不支持' : ''),
          value: state.pace, min: 70, max: 130, step: 5
        });
        var fInt = numField({
          label: '情绪幅度（0–100）' + (feat && feat.emotion === 'none' ? ' · 这家没有情绪通道' : ''),
          value: state.emotionIntensity, min: 0, max: 100, step: 5
        });
        var fRes = numField({
          label: '表达克制度（0–100，越高越收着）',
          value: state.restraint, min: 0, max: 100, step: 5
        });
        [fPace, fInt, fRes].forEach(function (f) { gHow.card.appendChild(f.el); });

        var swAuto = switchField({
          label: '情绪自动判断',
          hint: '关掉的话只用「平静」，不会因为话里的情绪起伏',
          value: !!state.emotionAuto
        });
        var swPause = switchField({
          label: '自然停顿优化' + (feat && !feat.pause ? ' · 这家不支持' : ''),
          hint: '在句末插停顿标记：MiniMax 用 <#x#>、Azure 用 <break/>；' +
            'Fish / ElevenLabs / 自建那几家没有可控的停顿字段，一个标记都不会插。' +
            '只作用于**临时合成文本**，聊天原文一个字都不动',
          value: !!state.naturalPause
        });
        gHow.card.appendChild(swAuto.el);
        gHow.card.appendChild(swPause.el);

        var saveNums = function () {
          if (ro) return;
          persist({
            pace: fPace.get() == null ? 100 : fPace.get(),
            emotionIntensity: fInt.get() == null ? 50 : fInt.get(),
            restraint: fRes.get() == null ? 70 : fRes.get()
          });
        };
        [fPace, fInt, fRes].forEach(function (f) {
          if (ro && f.input) f.input.disabled = true;
          else if (f.input) f.input.addEventListener('change', saveNums);
        });
        if (ro) { swAuto.input.disabled = true; swPause.input.disabled = true; }
        swAuto.input.addEventListener('change', function () { if (!ro) persist({ emotionAuto: swAuto.get() }); });
        swPause.input.addEventListener('change', function () { if (!ro) persist({ naturalPause: swPause.get() }); });
        body.appendChild(gHow.wrap);

        /* ---- 允许的表达 ---- */
        var gAllow = group('允许表达',
          '这两张表是**白名单**：不在表里的情绪与表演，导演永远不会用。' +
          '默认没开哭腔与气声 —— 那是强表演，容易翻车。' +
          (feat && !feat.tags
            ? '\n⚠️ 当前这条连接**没有表演标签能力**（只有 Fish / MiniMax 2.8 / ElevenLabs v3 有），' +
              '这两张表对它不生效 —— 情绪仍会按 ' + feat.emoLabel + ' 表达。'
            : ''));
        var emoAll = tts.EMOTIONS.map(function (e) { return { id: e, label: EMO_LABEL[e] || e }; });
        var tagAll = tts.TAGS.map(function (t) { return { id: t, label: TAG_LABEL[t] || t }; });
        var chipE = chipField('允许的情绪', '', emoAll, state.allowedEmotions, function (list) {
          if (ro) { ctx.toast('先点「单独设置」', 'warn'); return; }
          persist({ allowedEmotions: list });
        });
        var chipT = chipField('允许的表演方式', '', tagAll, state.allowedPerformanceTags, function (list) {
          if (ro) { ctx.toast('先点「单独设置」', 'warn'); return; }
          persist({ allowedPerformanceTags: list });
        });
        gAllow.card.appendChild(chipE.el);
        gAllow.card.appendChild(chipT.el);
        body.appendChild(gAllow.wrap);

        /* ---- 角色表达方向 ---- */
        var gDir = group('TA 的表达习惯',
          '写给导演看的一句话：TA 平时怎么说话、生气是什么样、有什么口头习惯。\n' +
          '规则版导演把它当**低权重先验**用（只在正文没给出情绪时参考，并读「慢 / 快」微调语速）；' +
          '模型版导演会把它整句带给模型当判断依据。两种情况下这句话都**不会**进合成文本' +
          '（导演不许吐服务商字符串）。');
        var fDir = textArea({
          label: '表达方向（可选）',
          value: state.characterDirection || '',
          rows: 5,
          placeholder: '例：说话慢，句尾常带「你懂吧」；生气时不吼人，只会更客气'
        });
        if (ro) fDir.el.querySelector('textarea').disabled = true;
        else {
          fDir.el.querySelector('textarea').addEventListener('change', function () {
            persist({ characterDirection: fDir.get() });
          });
        }
        gDir.card.appendChild(fDir.el);
        body.appendChild(gDir.wrap);

        /* ---- 播放 ---- */
        var gPlay = group('播放', '');
        var fAuto = selectField('自动播放', '',
          [{ id: 'global', label: '跟随全局' }, { id: 'auto', label: '生成完自动播' },
           { id: 'manual', label: '只在我点时播' }],
          state.autoplay, function (v) {
            if (ro) return; persist({ autoplay: v });
          });
        if (ro) fAuto.select.disabled = true;
        gPlay.card.appendChild(fAuto.el);
        var swKeep = switchField({
          label: '保留文字稿',
          hint: '关掉的话语音条会替掉气泡里的文字（搜索和记忆仍然保留原文）',
          value: !!state.keepTranscript
        });
        var swManual = switchField({
          label: '长按给「朗读」',
          hint: '关掉就没有手动朗读入口',
          value: !!state.manualRead
        });
        gPlay.card.appendChild(swKeep.el);
        gPlay.card.appendChild(swManual.el);
        if (ro) { swKeep.input.disabled = true; swManual.input.disabled = true; }
        swKeep.input.addEventListener('change', function () { if (!ro) persist({ keepTranscript: swKeep.get() }); });
        swManual.input.addEventListener('change', function () { if (!ro) persist({ manualRead: swManual.get() }); });
        body.appendChild(gPlay.wrap);

        /* ---- 试听 ---- */
        var gTry = group('试听', '走真实链路：检查连接 → 语音计划 → 组装 → 请求 → 播放。');
        var tryLine = h('input', 'set-input tts-try-input');
        tryLine.value = '你怎么现在才回来？';
        gTry.card.appendChild(tryLine);
        var tryActs = h('div', 'btn-row');
        tryActs.appendChild(button('按这件角色的设置读一次', 'primary', function () {
          if (!tts.settings().enabled) { ctx.toast('语音总开关还关着', 'warn'); return; }
          if (!state.voiceId) { ctx.toast('先填音色 ID', 'warn'); return; }
          var out = tryOut;
          runSpeech(ctx, {
            charId: charId,
            text: String(tryLine.value || '').trim() || '你好。',
            diag: true
          }, out);
        }));
        gTry.card.appendChild(tryActs);
        var tryOut = h('div', 'tts-result');
        gTry.card.appendChild(tryOut);
        body.appendChild(gTry.wrap);

        body.appendChild(h('p', 'set-group-note',
          '这一页的所有控件读写的是同一份 voiceState —— 改了就在，不存在「界面上变了但没存」。'));
        body.appendChild(h('div', 'lh-scroll-pad'));
      }

      var EMO_LABEL = {
        neutral: '平静', happy: '开心', tender: '温柔', concerned: '担心', sad: '难过',
        disappointed: '失望', surprised: '惊讶', angry: '生气', annoyed: '烦躁',
        cold: '冷淡', tired: '疲惫'
      };
      var TAG_LABEL = {
        soft: '轻声', low: '压低', laugh: '轻笑', sigh: '叹气',
        whisper: '耳语', breathy: '气声', crying: '哭腔'
      };

      ctx.rebuild = build;
      build();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ---------------------------- 说明弹层 ---------------------------- */

  function credentialNote(ctx) {
    ui.confirm({
      title: '凭据与隐私',
      note: 'API Key 只存在这台设备上（跟主 API 一样），不进入角色数据、聊天正文、记忆或日志；' +
        '报错日志里只出现 Key 的后四位。Sleepy 是本地优先的应用，没有服务端代收凭据 —— ' +
        '所以「服务端代管 Key」这件事在这里做不到，我们也不会假装做到了。' +
        '导出备份时会连 Key 一起导出（否则你换设备就要重新填一遍）；' +
        '不想带走 Key 的话，导出后自己删掉那几行。',
      ok: '知道了',
      cancel: '关闭'
    });
  }

  function pipelineNote(ctx) {
    ui.confirm({
      title: '语音是怎么做出来的',
      note: '① 你的角色原话（聊天里真正显示、保存、搜索、进记忆的那段）不会被改动；' +
        '② 语音导演按这句话的情绪给出一份「计划」（情绪 / 幅度 / 克制度 / 语速 / 表演方式）；' +
        '③ 服务商适配器把计划翻译成那家服务认识的标签，拼成一份**临时的合成文本**；' +
        '④ 只有这份临时文本会被送去做语音，回来的是音频。' +
        '标签永远不会出现在聊天气泡、搜索、记忆和导出里。',
      ok: '知道了',
      cancel: '关闭'
    });
  }

  function pickConnection(ctx, providerId) {
    var list = tts.connections().filter(function (c) { return c.provider === providerId; });
    ui.prompt({
      title: '换一条连接',
      note: list.map(function (c, i) {
        return (i + 1) + '. ' + (c.displayName || '连接') + '（' + tts.connectionSummary(c) + '）';
      }).join('\n') + '\n\n填序号。',
      value: '1',
      ok: '切换'
    }).then(function (v) {
      if (v === null) return;
      var idx = parseInt(String(v || ''), 10);
      if (!idx || idx < 1 || idx > list.length) { ctx.toast('序号不对', 'warn'); return; }
      ctx.params.connId = list[idx - 1].id;
      if (ctx.rebuild) ctx.rebuild();
      ctx.toast('已切到「' + (list[idx - 1].displayName || '连接') + '」', 'ok');
    });
  }

  function diag(ctx, providerId, c) {
    if (!c) { ctx.toast('先建一条连接', 'warn'); return; }
    /* 诊断必须用一份**能出计划**的配置：默认配置 enabled 是 false，
       那样计划里什么都没有，看诊断的人会以为「导演压根没工作」。 */
    var cfg = tts.voiceConfigOf('');
    cfg.enabled = true;
    var text = '你今天怎么这么晚才回来？';
    var plan = tts.speechPlanOf(text, cfg, { manual: true, rng: function () { return 0; } });
    var req = tts.buildRequest({
      provider: providerId, conn: c, model: tts.settings().defaultModel,
      voiceId: c.testVoiceId || '(未填音色)', plan: plan,
      originalText: text, output: tts.settings().output
    });
    ui.confirm({
      title: '高级诊断（脱敏）',
      note: '原文：' + text + '\n' +
        '计划：' + plan.emotion + ' / 强度 ' + plan.intensity + ' / 克制 ' + plan.restraint +
        ' / 语速 ' + plan.pace + '\n' +
        '临时合成文本：' + (req.synthesisText || '(未生成)') + '\n' +
        '请求地址：' + req.url + '\n' +
        '凭据：' + tts.maskKey(c.apiKey) + '（只显示后四位）',
      ok: '知道了',
      cancel: '关闭'
    });
  }

})(window);
