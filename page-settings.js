/* ============================================================
   page-settings.js — 设置
   依赖：store.js、ui.js、app.js（必须在它们之后加载）
   覆盖 ROADMAP：2.1 设置页框架 / 2.2 主 API 配置 + 测试连接 / 2.4 本地存储
   页面：settings → settings-mainapi / settings-subapi
         （settings-backup 在 page-backup.js 里注册）

   **进设置就是那些接口本身**：主 API / 副 API / TTS / 向量 / 总结 / 生图 /
   天气搜索 WebDAV 直接列在一级页上，点一行就是那一项的配置。
   中间那层「模型连接」已经拿掉 —— 用户：「进入设置 app，直接就是：主 api、
   副 api、tts、向量 api、总结 api 和其他原本那几个」。

   这里只放「业务」：读写哪个字段、调用哪个接口。
   按钮/输入框/卡片一律来自 Sleepy.ui，本文件不再自己造 DOM 组件。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var setRowValue = ui.setRowValue;
  var setRowBadge = ui.setRowBadge;
  var textField = ui.textField;
  var numField = ui.numField;
  var switchField = ui.switchField;
  var button = ui.button;
  var fmtBytes = ui.fmtBytes;

  /* ------------------------- 接口地址归一化 ------------------------- */

  var ENDPOINT_RE = /\/chat\/completions$/i;

  /* 用户很容易只填到 /v1，也会有人把完整地址整条粘进来。两种都认 */
  function normalizeEndpoint(baseUrl) {
    var u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (ENDPOINT_RE.test(u)) return u;
    return u + '/chat/completions';
  }

  /* 测试连接。永远用非流式，好拿完整 JSON 和 usage */
  function runTest(cfg) {
    return new Promise(function (resolve) {
      var url = normalizeEndpoint(cfg.baseUrl);
      if (!url) { resolve({ ok: false, stage: 'config', message: '先填接口地址' }); return; }
      if (!cfg.model) { resolve({ ok: false, stage: 'config', message: '先填模型名' }); return; }

      var secs = Math.max(1, cfg.timeoutSec || 60);
      var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, secs * 1000) : null;
      var t0 = Date.now();

      var headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

      global.fetch(url, {
        method: 'POST',
        headers: headers,
        mode: 'cors',
        signal: ctrl ? ctrl.signal : undefined,
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          max_tokens: 32,
          temperature: cfg.temperature,
          messages: [{ role: 'user', content: 'ping' }]
        })
      }).then(function (r) {
        return r.text().then(function (txt) {
          var ms = Date.now() - t0;
          if (!r.ok) {
            resolve({ ok: false, stage: 'http', status: r.status, ms: ms,
              message: 'HTTP ' + r.status, detail: txt.slice(0, 400) });
            return;
          }
          var data = null;
          try { data = JSON.parse(txt); } catch (e) { /* 落到下面 */ }
          if (!data) {
            resolve({ ok: false, stage: 'parse', status: r.status, ms: ms,
              message: '返回的不是 JSON', detail: txt.slice(0, 400) });
            return;
          }
          var choice = data.choices && data.choices[0];
          var content = (choice && choice.message && choice.message.content) || '';
          resolve({ ok: true, ms: ms, status: r.status,
            reply: content.slice(0, 120), usage: data.usage || null,
            model: data.model || cfg.model });
        });
      })['catch'](function (err) {
        var ms = Date.now() - t0;
        var aborted = err && err.name === 'AbortError';
        resolve({
          ok: false,
          stage: aborted ? 'timeout' : 'network',
          ms: ms,
          message: aborted ? ('超时：' + secs + ' 秒没有响应')
                           : '连不上：网络错误，或这个接口没有开 CORS',
          detail: (err && err.message) || String(err)
        });
      }).then(function () { if (timer) clearTimeout(timer); });
    });
  }

  function renderTestResult(box, res) {
    box.innerHTML = '';
    box.className = 'test-result ' + (res.ok ? 'is-ok' : 'is-err');

    box.appendChild(h('p', 'test-title', res.ok ? '连上了' : '没连上'));

    var kv = h('div', 'test-kv');
    function line(k, v) {
      var r = h('div', 'test-line');
      r.appendChild(h('span', 'test-k', k));
      r.appendChild(h('span', 'test-v', v));
      kv.appendChild(r);
    }
    if (res.ms !== undefined) line('耗时', res.ms + ' ms');
    if (res.model) line('模型', res.model);
    if (res.usage && res.usage.total_tokens) line('tokens', String(res.usage.total_tokens));
    if (!res.ok) line('原因', res.message);
    box.appendChild(kv);

    if (res.ok && res.reply) box.appendChild(h('p', 'test-reply', '「' + res.reply + '」'));
    if (!res.ok && res.detail) box.appendChild(h('p', 'test-detail', res.detail));

    if (!res.ok && res.stage === 'network') {
      box.appendChild(h('p', 'test-tip',
        '网页版受浏览器跨域限制：接口方必须返回 CORS 头才能连。' +
        '换成支持跨域的中转地址，或用官方开放了 CORS 的渠道。'));
    }
  }

  /* ----------------------------- 摘要 ----------------------------- */

  function usageText() {
    var u = store.usage();
    return fmtBytes(u.bytes) + ' / ' + u.keys + ' 项';
  }

  function mainApiSummary() {
    var m = store.get('mainApi');
    return (m && m.baseUrl && m.model) ? '已配置' : '未配置';
  }

  function subApiSummary() {
    var list = store.get('subApis');
    if (!Array.isArray(list) || !list.length) return '未配置';
    var on = 0;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].enabled) on++;
    return '已启用 ' + on + ' / ' + list.length + ' 组';
  }

  /* ======================= 页面：设置（一级） ======================= */

  Sleepy.register('settings', {
    title: '设置',
    render: function (ctx) {
      var body = ctx.body;

      /* ============ 对话：主 / 副 ============
         这两行以前藏在「模型连接」里（设置 → 模型连接 → 主 API → 配置），
         点三层才摸到自己的 Key。现在**进设置就看得见** ——
         用户：「进入设置 app，直接就是：主 api、副 api、tts、向量 api、
         总结 api 和其他原本那几个」。 */
      var gTalk = group('对话');
      var rowMain = row({
        label: '主 API',
        hint: '日常对话走这一个',
        badge: mainApiSummary(),
        badgeKind: (mainApiSummary() === '已配置') ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-mainapi'); }
      });
      gTalk.card.appendChild(rowMain);

      var subText = subApiSummary();
      var rowSub = row({
        label: '副 API',
        hint: '用于其他功能（后台任务 · 备用通道）',
        badge: subText,
        badgeKind: (subText === '未配置') ? 'dim' : 'ok',
        onClick: function () { ctx.open('settings-subapi'); }
      });
      gTalk.card.appendChild(rowSub);
      body.appendChild(gTalk.wrap);

      /* ============ 其他能力 ============
         还没接的那些也摆在这儿 —— 占位要摆在对的位置，
         不然用户根本不知道这 App 以后能长成什么样。灰着的行点不动。 */
      var gCap = group('其他能力', '这几项还没接上，编号是它在计划里的位置。');
      gCap.card.appendChild(row({ label: '语音 TTS', hint: '2.15 让角色把回复读出来' }));
      gCap.card.appendChild(row({ label: '向量记忆 API', hint: '2.13 填 embedding 模型，不是对话模型' }));
      gCap.card.appendChild(row({ label: '总结 API', hint: '2.14 便宜模型跑记忆抽取' }));
      /* 生图已经接上了（page-imggen.js）—— 用户：「不开独立 App，从设置进」 */
      var rowImg = row({
        label: '生图',
        hint: '接口 · 提示词库 · 试一张',
        badge: Sleepy.imggen ? Sleepy.imggenSummary() : '未配置',
        badgeKind: (Sleepy.imggen && Sleepy.imggenSummary() !== '未配置') ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-imggen'); }
      });
      gCap.card.appendChild(rowImg);
      gCap.card.appendChild(row({ label: '天气 / 搜索 / WebDAV', hint: '2.17' }));
      body.appendChild(gCap.wrap);

      /* 世界书（B 模块）是首页 App，不挂设置 —— 它跟名片夹一样，
         是「用户自己往里加东西」的地方，设置里只放引擎怎么连。 */

      var g2 = group('外观与文字');
      g2.card.appendChild(row({ label: '主题与字号', hint: '夜灯 / 浅色 + 字号' }));
      body.appendChild(g2.wrap);

      /* 角色相关的入口（原来的「人设预设库」）不在这里 ——
         它本来就是「新增角色」，已经搬到首页的名片夹。 */

      var g4 = group('数据与备份');
      var rowData = row({
        label: '数据与备份',
        hint: '导出 · 导入 · 存储空间 · 清理',
        value: usageText(),
        onClick: function () { ctx.open('settings-backup'); }
      });
      g4.card.appendChild(rowData);
      body.appendChild(g4.wrap);

      var g5 = group('其他');
      g5.card.appendChild(row({ label: '激活与设备', hint: '2.19 激活码 · QQ 绑定' }));
      /* 「关于 Sleepy」背着隐蔽开关：3 秒内连点 5 次 = 切开发者模式。
         面向用户后内置 prompt 上锁，这个开关是唯一的解锁口 ——
         所以它不能像普通开关一样摆在明面上（用户：「隐蔽一些qwq」）。
         row() 不带 onClick 会把自己 disabled 掉，这里手动解开再挂事件。 */
      var aboutRow = row({ label: '关于 Sleepy', hint: '2.18 版本 · 更新日志' });
      aboutRow.disabled = false;
      aboutRow.classList.remove('is-soon');
      var devTaps = 0, devTimer = null;
      aboutRow.addEventListener('click', function () {
        devTaps++;
        if (devTimer) clearTimeout(devTimer);
        devTimer = setTimeout(function () { devTaps = 0; }, 3000);
        if (devTaps < 5) return;
        devTaps = 0;
        if (devTimer) { clearTimeout(devTimer); devTimer = null; }
        var next = !(store.get('presetEngine') || {}).developerMode;
        Sleepy.promptEngine.setDev(next);
        ctx.toast(next ? '开发者模式已开启' : '开发者模式已关闭', 'ok');
      });
      g5.card.appendChild(aboutRow);
      body.appendChild(g5.wrap);

      var foot = h('p', 'set-foot', '');
      body.appendChild(foot);

      /* 刷新闭包挂在 ctx 上，onShow 直接调。
         只改文字、不重建 DOM，从下级页返回时滚动位置不会丢。 */
      ctx.refreshSummary = function () {
        var m = mainApiSummary();
        /* 主 / 副 API 用的是 **badge**（小胶囊），不是 value ——
           别拿 setRowValue 去改它，那会在右边再多出一份文字。 */
        setRowBadge(rowMain, m, m === '已配置' ? 'ok' : 'dim');
        var s = subApiSummary();
        setRowBadge(rowSub, s, s === '未配置' ? 'dim' : 'ok');
        var im = Sleepy.imggen ? Sleepy.imggenSummary() : '未配置';
        setRowBadge(rowImg, im, im === '未配置' ? 'dim' : 'ok');
        setRowValue(rowData, usageText());
        foot.textContent = '灰着的行是还没贴好的 · 当前存档 ' + usageText();
      };
      ctx.refreshSummary();
    },
    onShow: function (ctx) { if (ctx.refreshSummary) ctx.refreshSummary(); }
  });

  /* 这里原来注册过一页「聊天默认参数」（settings-chatdefaults）。
     已删：温度 / 上限 / 上下文条数 / 流式 都是**每个接口自己的生成参数**，
     在接口配置页（settings-api）里各有一份，改的是同一批值；
     两处都能改，迟早出现「在这里改了、请求里还是老值」。
     「回复时附带心声」的开关也没丢 —— 心跳 App 里有它自己的入口。
     store 的 chatDefaults 仍然在（api.js 拿它做第三层兜底），只是不再有 UI 去改它。 */

  /* 这里原来注册过一页「模型连接」（settings-model）。
     已删：它就是主 API / 副 API / 后台任务的一个**中转列表**，
     结果是「设置 → 模型连接 → 主 API → 配置」点三层才摸到自己的 Key。
     现在这些行直接摆在设置一级页上（见本文件顶部的说明）。
     顺带：那页的 refreshSummary 用 setRowValue 去改 badge，
     而 badge 是另一个元素 —— 返回时会在那一行多出一份文字。
     ui 里补了 setRowBadge()，这次的刷新走它。 */

  /* ==================== 主 API：多预设公共部分 ====================
     主 API 可以存好几套预设，切换＝换「当前使用」的那套。
     mainApi 键始终镜像当前使用的配置（api.js 只读它），所以
     每次切当前/改当前配置，都要顺手把 mainApi 同步一遍。 */

  function mainApiPresets() {
    var l = store.get('mainApis');
    return Array.isArray(l) ? l : [];
  }

  function activeMainId() {
    var v = store.get('mainApiId');
    return v ? String(v) : '';
  }

  function saveMainPresets(list) { return store.set('mainApis', list); }

  /* 把预设镜像进 mainApi（api.js 的候选列表只认 mainApi） */
  function syncActiveMainApi(preset) {
    if (!preset) return false;
    return store.set('mainApi', {
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      temperature: preset.temperature,
      maxTokens: preset.maxTokens,
      contextMessages: preset.contextMessages,
      timeoutSec: preset.timeoutSec,
      stream: preset.stream,
      enabled: preset.enabled
    });
  }

  /* 接口表单的公共字段（主 API 新增/编辑共用，只管「接口」这一组）。
     拉取模型列表：调 {base}/models，点返回的模型名直接填进模型名输入框。 */
  function buildApiFields(gCard, cfg) {
    var f = {};

    f.name = textField({ label: '备注名', value: cfg.name, placeholder: '' });
    gCard.appendChild(f.name.el);

    f.baseUrl = textField({
      label: '接口地址 Base URL',
      hint: '填到 /v1 就行，测试时会自动补 /chat/completions',
      value: cfg.baseUrl,
      placeholder: 'https://api.example.com/v1',
      inputmode: 'url'
    });
    gCard.appendChild(f.baseUrl.el);

    f.apiKey = textField({
      label: 'API Key',
      hint: '明文存在本机浏览器，换设备不会跟着走',
      value: cfg.apiKey,
      placeholder: 'sk-...',
      password: true
    });
    gCard.appendChild(f.apiKey.el);

    f.model = textField({
      label: '模型名',
      value: cfg.model,
      placeholder: ''
    });
    gCard.appendChild(f.model.el);

    /* 拉取模型：模型名旁边的小圆钮（和生图设置同款交互），
       用表单里当前的地址和 Key，不用先保存。
       点返回的模型名填进输入框，列表随即收起（用户：选完别杵着）。 */
    var mini = h('button', 'set-mini-ic');
    mini.type = 'button';
    mini.title = '拉取模型列表';
    mini.setAttribute('aria-label', '拉取模型列表');
    mini.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M4 10a6 6 0 0 1 10.4-4.1M16 10a6 6 0 0 1-10.4 4.1M14.5 2.5v3.6h-3.6M5.5 17.5v-3.6h3.6"/></svg>';
    f.model.el.querySelector('.set-line').appendChild(mini);

    var pickBox = h('div', 'model-pick');
    gCard.appendChild(pickBox);

    mini.addEventListener('click', function () {
      mini.disabled = true;
      pickBox.innerHTML = '';
      pickBox.appendChild(h('p', 'test-tip', '正在拉取…'));
      Sleepy.api.fetchModels({
        baseUrl: f.baseUrl.get(),
        apiKey: f.apiKey.get()
      }).then(function (res) {
        mini.disabled = false;
        pickBox.innerHTML = '';
        if (!res.ok) {
          pickBox.appendChild(h('p', 'test-tip', '没拉到：' + res.message));
          if (res.detail) pickBox.appendChild(h('p', 'test-detail', res.detail));
          return;
        }
        if (!res.models.length) {
          pickBox.appendChild(h('p', 'test-tip', '接口返回了空列表'));
          return;
        }
        pickBox.appendChild(h('p', 'test-tip',
          '拉到 ' + res.models.length + ' 个，点一个填进模型名'));
        res.models.slice(0, 60).forEach(function (id) {
          var r = h('button', 'set-row model-pick-row');
          r.type = 'button';
          r.appendChild(h('span', 'set-row-label', id));
          r.addEventListener('click', function () {
            f.model.input.value = id;
            pickBox.innerHTML = '';      /* 选完即收起 */
          });
          pickBox.appendChild(r);
        });
      });
    });

    return f;
  }

  /* ==================== 页面：主 API（预设列表） ==================== */

  Sleepy.register('settings-mainapi', {
    title: '主 API',
    render: function (ctx) {
      var body = ctx.body;

      var g = group('主 API 预设',
        '可以存好几套，随时切换当前使用的那套。点一个进去改。');
      var listCard = g.card;

      function refresh() {
        listCard.innerHTML = '';
        var list = mainApiPresets();
        var act = activeMainId();

        if (!list.length) {
          listCard.appendChild(row({ label: '还没有预设', plain: true }));
        } else {
          list.forEach(function (p) {
            var isCur = p.id === act;
            listCard.appendChild(row({
              label: p.name || '未命名预设',
              hint: p.model || '还没填模型名',
              badge: isCur ? '当前使用' : (p.enabled ? '备用' : '已停用'),
              badgeKind: isCur ? 'ok' : 'dim',
              onClick: function () { ctx.open('settings-mainapi-edit', { id: p.id }); }
            }));
          });
        }

        listCard.appendChild(row({
          label: '添加新预设',
          onClick: function () { ctx.open('settings-mainapi-add'); }
        }));
      }

      refresh();
      body.appendChild(g.wrap);

      var foot = h('p', 'set-foot', '所有 Key 只存在这台设备的浏览器里，不经过我的服务器。');
      body.appendChild(foot);

      ctx.rebuild = refresh;
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* 主 API 表单页的公共渲染（新增 / 编辑共用）。 */
  function renderMainApiForm(ctx, preset, isNew) {
    var body = ctx.body;
    var def = store.defaults().chatDefaults;
    var f = {};

    var g = group('接口');
    f = buildApiFields(g.card, preset);

    var g2 = group('生成参数', '这个接口自己的。留空就用内置默认值（灰字就是它）。');
    f.temperature = numField({ label: '温度', hint: '留空＝用内置默认 · 越高越发散', value: preset.temperature, min: 0, max: 2, step: 0.05 });
    f.temperature.input.placeholder = String(def.temperature);
    g2.card.appendChild(f.temperature.el);
    f.maxTokens = numField({ label: '单次回复上限', hint: '留空＝用内置默认', value: preset.maxTokens, min: 64, max: 32768, step: 64 });
    f.maxTokens.input.placeholder = String(def.maxTokens);
    g2.card.appendChild(f.maxTokens.el);
    f.contextMessages = numField({ label: '携带上下文条数', hint: '留空＝用内置默认 · 越多越记得住，也越贵', value: preset.contextMessages, min: 2, max: 200, step: 2 });
    f.contextMessages.input.placeholder = String(def.contextMessages);
    g2.card.appendChild(f.contextMessages.el);
    f.timeoutSec = numField({ label: '超时（秒）', value: preset.timeoutSec, min: 5, max: 300, step: 5 });
    f.timeoutSec.input.placeholder = '60';
    g2.card.appendChild(f.timeoutSec.el);
    body.appendChild(g.wrap);
    body.appendChild(g2.wrap);

    var g3 = group('开关');
    f.stream = switchField({
      label: '流式输出',
      hint: '打字机效果。关掉＝这个接口不走流式（默认开）',
      value: preset.stream
    });
    g3.card.appendChild(f.stream.el);
    f.enabled = switchField({ label: '启用这个接口', value: preset.enabled });
    g3.card.appendChild(f.enabled.el);
    /* 「当前使用」：同一时间只有一套在干活。新增时不给（存完自动成为当前） */
    f.isCurrent = null;
    if (!isNew) {
      f.isCurrent = switchField({
        label: '当前使用这套',
        hint: '关掉会自动把「当前」让给列表里的第一套别的',
        value: preset.id === activeMainId()
      });
      g3.card.appendChild(f.isCurrent.el);
    }
    body.appendChild(g3.wrap);

    /* 测试区 */
    var g4 = group('测试连接');
    var testBox = h('div', 'test-result is-idle');
    testBox.appendChild(h('p', 'test-title', '还没测过'));
    testBox.appendChild(h('p', 'test-tip',
      '测试用表单里当前的值，不需要先保存；发一条 ping，非流式。'));
    g4.card.appendChild(testBox);

    var btnRow = h('div', 'btn-row');
    var testBtn = button('测试连接', 'ghost', function () { doTest(); });
    var saveBtn = button('保存', 'primary', function () { doSave(); });
    var delBtn = null;
    if (!isNew) {
      delBtn = button('删除', 'danger', function () { doDelete(); });
      btnRow.appendChild(delBtn);
    }
    btnRow.appendChild(testBtn);
    btnRow.appendChild(saveBtn);
    g4.card.appendChild(btnRow);
    body.appendChild(g4.wrap);

    ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

    function collect() {
      return {
        id: preset.id,
        name: f.name.get() || '主模型',
        baseUrl: f.baseUrl.get(),
        apiKey: f.apiKey.get(),
        model: f.model.get(),
        temperature: f.temperature.get(),
        maxTokens: Math.round(f.maxTokens.get()),
        contextMessages: Math.round(f.contextMessages.get()),
        timeoutSec: Math.round(f.timeoutSec.get()),
        stream: f.stream.get(),
        enabled: f.enabled.get()
      };
    }

    function doSave() {
      var next = collect();
      var list = mainApiPresets();
      var idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === next.id) { idx = i; break; }
      }
      if (idx >= 0) list[idx] = next; else list.push(next);

      /* 「当前使用」落定：开了开关就用这套；关掉且原来是当前 → 让给第一套别的 */
      var act = activeMainId();
      var wantCurrent = isNew ? true : !!(f.isCurrent && f.isCurrent.get());
      if (wantCurrent) {
        store.set('mainApiId', next.id);
      } else if (next.id === act) {
        var other = '';
        for (var j = 0; j < list.length; j++) {
          if (list[j].id !== next.id) { other = list[j].id; break; }
        }
        store.set('mainApiId', other);
      }

      var ok = saveMainPresets(list);
      /* mainApi 镜像：指向谁就同步谁；没有当前了就按停用处理，别让旧配置偷偷还在干活 */
      var actNow = activeMainId();
      var cur = null;
      for (var k = 0; k < list.length; k++) {
        if (list[k].id === actNow) { cur = list[k]; break; }
      }
      if (cur) syncActiveMainApi(cur);
      else store.set('mainApi', { enabled: false });

      if (ok) {
        ctx.toast(wantCurrent ? '已保存并设为当前' : '已保存', 'ok');
        ctx.back();
      } else {
        ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
      }
    }

    function doDelete() {
      var list = mainApiPresets().filter(function (x) { return x.id !== preset.id; });
      var wasActive = preset.id === activeMainId();
      var ok = saveMainPresets(list);
      if (wasActive) {
        var other = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].enabled) { other = list[i]; break; }
        }
        if (other) {
          store.set('mainApiId', other.id);
          syncActiveMainApi(other);
        } else {
          store.set('mainApiId', '');
          store.set('mainApi', { enabled: false });
        }
      }
      if (ok) {
        ctx.toast('已删除', 'ok');
        ctx.back();
      } else {
        ctx.toast('删除失败', 'err');
      }
    }

    function doTest() {
      var next = collect();
      testBtn.disabled = true;
      saveBtn.disabled = true;
      if (delBtn) delBtn.disabled = true;
      testBox.className = 'test-result is-loading';
      testBox.innerHTML = '';
      testBox.appendChild(h('p', 'test-title', '正在连…'));
      testBox.appendChild(h('p', 'test-tip', normalizeEndpoint(next.baseUrl) || '接口地址是空的'));

      runTest(next).then(function (res) {
        renderTestResult(testBox, res);
        testBtn.disabled = false;
        saveBtn.disabled = false;
        if (delBtn) delBtn.disabled = false;
        if (res.ok) ctx.toast('连上了 · ' + res.ms + 'ms', 'ok');
      });
    }
  }

  /* ==================== 页面：新增主 API 预设 ==================== */

  Sleepy.register('settings-mainapi-add', {
    title: '新增主 API',
    render: function (ctx) {
      var def = store.defaults().chatDefaults;
      var preset = {
        id: 'map' + Date.now().toString(36),
        name: '',
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: null,
        maxTokens: null,
        contextMessages: null,
        timeoutSec: null,
        stream: def.stream !== false,
        enabled: true
      };
      renderMainApiForm(ctx, preset, true);
    }
  });

  /* ==================== 页面：编辑主 API 预设 ==================== */

  Sleepy.register('settings-mainapi-edit', {
    title: '编辑主 API',
    render: function (ctx) {
      var id = ctx.params.id;
      var preset = null;
      mainApiPresets().forEach(function (p) {
        if (p.id === id) preset = p;
      });
      if (!preset) {
        ctx.toast('找不到这套预设', 'err');
        ctx.back();
        return;
      }
      renderMainApiForm(ctx, preset, false);
    }
  });

})(window);
