/* ============================================================
   page-subapi.js — 副 API 配置
   依赖：store.js、ui.js、app.js（必须在它们之后加载）
   覆盖 ROADMAP：2.3 副 API 配置（多组 + 轮询顺序 + 启用开关）+ 测试连接
   页面：settings-subapi → settings-subapi-add → settings-subapi-test

   这里只放「业务」：读写 subApis 字段、测试单个接口。
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

  /* 测试单个副 API。永远用非流式，好拿完整 JSON 和 usage */
  function runTest(cfg) {
    return new Promise(function (resolve) {
      var url = normalizeEndpoint(cfg.baseUrl);
      if (!url) { resolve({ ok: false, stage: 'config', message: '先填接口地址' }); return; }
      if (!cfg.model) { resolve({ ok: false, stage: 'config', message: '先填模型名' }); return; }

      /* 数字化的下限兜底：cfg.timeoutSec 可能是 0，也可能是字符串 '0'（老存档）。
         后者是 truthy —— `cfg.timeoutSec || 60` 拦不住它，会被
         Math.max(1, '0') 算成 **1 秒**（2026-09-23 全链路排查）。 */
      var secs = Number(cfg.timeoutSec);
      if (!(secs >= 5)) secs = 60;
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


  function summary() {
    var list = store.get('subApis');
    if (!Array.isArray(list) || !list.length) return '未配置';
    var enabledCount = list.filter(function (it) { return !!it.enabled; }).length;
    return '已启用 ' + enabledCount + ' / ' + list.length + ' 组';
  }

  /* 模型名输入框 + 小圆钮拉取，插进 g.card。
     拉取结果走**浮层**（ui.modelPickButton → ui.modelPicker），不再铺在卡片里 ——
     拉一次可能回 60 个模型名，铺在卡片里整页会被拉得很长，用户得一直往下滚
     整页。浮层里自己滚 + 顶部搜索框，点一个填进去、框随即收掉。

     connOf 是**调用方**传进来的取连接信息的函数（返回 {baseUrl, apiKey}）。
     为什么不能在这个函数里直接读 f.baseUrl —— 这里的 f 是**本函数内部的
     另一个对象**，调用方那套 f.baseUrl / f.apiKey 根本不在它身上（以前就是
     这么写的，点「拉取」直接 `undefined.get()` 抛错，被 P0-2 的崩掩盖着，
     2026-09-21 一并修掉）。 */
  function modelFieldWithPicker(gCard, value, connOf) {
    var f = {};
    f.model = textField({ label: '模型名', value: value || '', placeholder: '' });
    gCard.appendChild(f.model.el);
    var mini = ui.modelPickButton({
      load: function () {
        var conn = connOf ? connOf() : null;
        if (!conn || !conn.baseUrl) return { ok: false, message: '先填接口地址' };
        return Sleepy.api.fetchModels(conn);
      },
      onPick: function (id) { f.model.input.value = id; }
    });
    f.model.el.querySelector('.set-line').appendChild(mini);
    return { f: f };
  }

  /* ==================== 页面：副 API 列表（二级） ==================== */


  Sleepy.register('settings-subapi', {
    title: '副 API',
    render: function (ctx) {
      var body = ctx.body;

      var g = group('API 列表', '给后台任务等用，也可以当备用通道。');
      var listCard = g.card;

      var g2 = group('轮询规则', '请求失败时自动跳下一个；全部失败则报错。');
      var rowCount = row({ label: '已配置副 API', plain: true });
      g2.card.appendChild(rowCount);
      /* 重试次数可调：改动即落盘（1~5） */
      var fRetry = numField({
        label: '每组重试次数',
        hint: '每组失败后最多再试这么多次，再不行就轮下一组',
        value: Math.max(1, Math.min(5, Math.round(Number(store.get('subRetry'))) || 2)),
        min: 1, max: 5, step: 1
      });
      g2.card.appendChild(fRetry.el);
      fRetry.input.addEventListener('change', function () {
        var v = Math.max(1, Math.min(5, Math.round(Number(fRetry.get())) || 2));
        store.set('subRetry', v);
        fRetry.input.value = String(v);
      });

      /* 页面是缓存复用的（app.js 只在第一次 open 时 render），
         所以增删之后必须靠这里重建列表，不能指望重新 render。 */
      function refresh() {
        listCard.innerHTML = '';
        var list = store.get('subApis');
        if (!Array.isArray(list)) list = [];

        if (list.length === 0) {
          listCard.appendChild(row({ label: '暂无副 API', plain: true }));
        } else {
          list.forEach(function (item, index) {
            listCard.appendChild(row({
              label: item.name || ('第 ' + (index + 1) + ' 组'),
              hint: normalizeEndpoint(item.baseUrl) || '未填地址',
              badge: item.enabled ? '已启用' : '已停用',
              badgeKind: item.enabled ? 'ok' : 'dim',
              onClick: function () { ctx.open('settings-subapi-edit', { id: item.id }); }
            }));
          });
        }

        listCard.appendChild(row({
          label: '添加新 API',
          onClick: function () { ctx.open('settings-subapi-add'); }
        }));
        setRowValue(rowCount, summary());
      }

      refresh();

      body.appendChild(g.wrap);
      body.appendChild(g2.wrap);

      var foot = h('p', 'set-foot', '所有 Key 只存在这台设备的浏览器里，不经过我的服务器。');
      body.appendChild(foot);

      ctx.rebuild = refresh;
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ==================== 页面：新增副 API（三级） ==================== */

  Sleepy.register('settings-subapi-add', {
    title: '新增副 API',
    render: function (ctx) {
      var body = ctx.body;
      var f = {};
      /* 生成参数的默认值只看 api.js 那一份（GEN_DEFAULTS）—— store 的
         chatDefaults 里已经不放生成参数了（见 store.js 的迁移注释）。
         数字项留空＝用内置默认，灰字就是它。 */
      var def = Sleepy.api.genDefaults;

      var g = group('接口');
      f.name = textField({ label: '备注名', placeholder: '' });
      g.card.appendChild(f.name.el);

      f.baseUrl = textField({
        label: '接口地址 Base URL',
        hint: '填到 /v1 就行，测试时会自动补 /chat/completions',
        placeholder: 'https://api.example.com/v1',
        inputmode: 'url'
      });
      g.card.appendChild(f.baseUrl.el);

      f.apiKey = textField({
        label: 'API Key',
        hint: '明文存在本机浏览器，换设备不会跟着走',
        placeholder: 'sk-...',
        password: true
      });
      g.card.appendChild(f.apiKey.el);

      /* modelFieldWithPicker 返回 {f:{model:字段}} 这种嵌套，而且要传一个
         「取连接信息」的函数（它内部的 f 不是这里的 f，读不到 baseUrl）——
         以前写成 f.model = mp.f + 重复 attachModelPicker，后果是
         f.model.input / f.model.get() 全是 undefined：
         模型选项点不动、点保存必抛错（2026-09-21 修）。 */
      var mp = modelFieldWithPicker(g.card, '', function () {
        return { baseUrl: f.baseUrl.get(), apiKey: f.apiKey.get() };
      });
      f.model = mp.f.model;
      body.appendChild(g.wrap);

      var g2 = group('生成参数', '这个接口自己的。留空就用内置默认值（灰字就是它）。');
      f.temperature = numField({ label: '温度', hint: '留空＝用内置默认 · 越高越发散', value: null, min: 0, max: 2, step: 0.05 });
      f.temperature.input.placeholder = String(def.temperature);
      g2.card.appendChild(f.temperature.el);
      f.maxTokens = numField({ label: '单次回复上限', hint: '留空＝用内置默认', value: null, min: 64, max: 32768, step: 64 });
      f.maxTokens.input.placeholder = String(def.maxTokens);
      g2.card.appendChild(f.maxTokens.el);
      f.contextMessages = numField({ label: '携带上下文条数', hint: '留空＝用内置默认 · 越多越记得住，也越贵', value: null, min: 2, max: 200, step: 2 });
      f.contextMessages.input.placeholder = String(def.contextMessages);
      g2.card.appendChild(f.contextMessages.el);
      f.timeoutSec = numField({ label: '超时（秒）', hint: '留空＝用内置默认', value: null, min: 5, max: 300, step: 5 });
      f.timeoutSec.input.placeholder = String(def.timeoutSec);
      g2.card.appendChild(f.timeoutSec.el);
      body.appendChild(g2.wrap);

      var g3 = group('开关');
      f.stream = switchField({
        label: '流式输出',
        hint: '打字机效果。总开关在「聊天默认参数」，这里关掉＝这个接口不走流式',
        value: def.stream !== false
      });
      g3.card.appendChild(f.stream.el);
      f.enabled = switchField({ label: '启用这个接口', value: true });
      g3.card.appendChild(f.enabled.el);
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
      btnRow.appendChild(testBtn);
      btnRow.appendChild(saveBtn);
      g4.card.appendChild(btnRow);
      body.appendChild(g4.wrap);

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      function collect() {
        return {
          id: String(Date.now()),
          name: f.name.get() || '',
          baseUrl: f.baseUrl.get(),
          apiKey: f.apiKey.get(),
          model: f.model.get(),
          temperature: f.temperature.get(),
          maxTokens: f.maxTokens.getNum(),
          contextMessages: f.contextMessages.getNum(),
          timeoutSec: f.timeoutSec.getNum(),
          stream: f.stream.get(),
          enabled: f.enabled.get()
        };
      }

      function doSave() {
        var next = collect();
        var list = store.get('subApis');
        if (!Array.isArray(list)) list = [];
        list.push(next);
        var ok = store.set('subApis', list);
        if (ok) {
          /* 顺手把**还空着的**「总结 API / 向量记忆 API」带一份进来
             （用户 2026-09-22 拍板：加副 API 可以同步加这两个）。
             只填空的：填过之后两边各自独立，改副 API / 删副 API 都不动它们。 */
          var seeded = 0;
          if (Sleepy.singleApi && Sleepy.singleApi.seedAll) seeded = Sleepy.singleApi.seedAll();
          ctx.toast(seeded ? '已保存，总结 / 向量接口也顺手带了一份' : '已保存', 'ok');
          ctx.back();
        } else {
          ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
        }
      }

      function doTest() {
        var next = collect();
        testBtn.disabled = true;
        saveBtn.disabled = true;
        testBox.className = 'test-result is-loading';
        testBox.innerHTML = '';
        testBox.appendChild(h('p', 'test-title', '正在连…'));
        testBox.appendChild(h('p', 'test-tip', normalizeEndpoint(next.baseUrl) || '接口地址是空的'));

        runTest(next).then(function (res) {
          renderTestResult(testBox, res);
          testBtn.disabled = false;
          saveBtn.disabled = false;
          if (res.ok) ctx.toast('连上了 · ' + res.ms + 'ms', 'ok');
        });
      }
    }
  });

  /* ==================== 页面：编辑副 API（三级） ==================== */

  Sleepy.register('settings-subapi-edit', {
    title: '编辑副 API',
    render: function (ctx) {
      var body = ctx.body;
      var params = ctx.params;
      var list = store.get('subApis');
      if (!Array.isArray(list)) list = [];
      var item = list.find(function (it) { return it.id === params.id; });
      if (!item) {
        ctx.toast('找不到该配置项', 'err');
        ctx.back();
        return;
      }
      var f = {};

      var g = group('接口');
      f.name = textField({ label: '备注名', value: item.name, placeholder: '' });
      g.card.appendChild(f.name.el);

      f.baseUrl = textField({
        label: '接口地址 Base URL',
        hint: '填到 /v1 就行，测试时会自动补 /chat/completions',
        value: item.baseUrl,
        placeholder: 'https://api.example.com/v1',
        inputmode: 'url'
      });
      g.card.appendChild(f.baseUrl.el);

      f.apiKey = textField({
        label: 'API Key',
        hint: '明文存在本机浏览器，换设备不会跟着走',
        value: item.apiKey,
        placeholder: 'sk-...',
        password: true
      });
      g.card.appendChild(f.apiKey.el);

      /* 同新增页：取 .f.model，并把「取连接信息」的函数传进去（2026-09-21 修）。 */
      var mp = modelFieldWithPicker(g.card, item.model, function () {
        return { baseUrl: f.baseUrl.get(), apiKey: f.apiKey.get() };
      });
      f.model = mp.f.model;
      body.appendChild(g.wrap);

      var g2 = group('生成参数', '这个接口自己的。留空就用内置默认值（灰字就是它）。');
      var def = Sleepy.api.genDefaults;
      f.temperature = numField({ label: '温度', hint: '留空＝用内置默认 · 越高越发散', value: item.temperature, min: 0, max: 2, step: 0.05 });
      f.temperature.input.placeholder = String(def.temperature);
      g2.card.appendChild(f.temperature.el);
      f.maxTokens = numField({ label: '单次回复上限', hint: '留空＝用内置默认', value: item.maxTokens, min: 64, max: 32768, step: 64 });
      f.maxTokens.input.placeholder = String(def.maxTokens);
      g2.card.appendChild(f.maxTokens.el);
      f.contextMessages = numField({ label: '携带上下文条数', hint: '留空＝用内置默认 · 越多越记得住，也越贵', value: item.contextMessages, min: 2, max: 200, step: 2 });
      f.contextMessages.input.placeholder = String(def.contextMessages);
      g2.card.appendChild(f.contextMessages.el);
      f.timeoutSec = numField({ label: '超时（秒）', hint: '留空＝用内置默认', value: item.timeoutSec, min: 5, max: 300, step: 5 });
      f.timeoutSec.input.placeholder = String(def.timeoutSec);
      g2.card.appendChild(f.timeoutSec.el);
      body.appendChild(g2.wrap);

      var g3 = group('开关');
      f.stream = switchField({
        label: '流式输出',
        hint: '打字机效果。总开关在「聊天默认参数」，这里关掉＝这个接口不走流式',
        value: item.stream
      });
      g3.card.appendChild(f.stream.el);
      f.enabled = switchField({ label: '启用这个接口', value: item.enabled });
      g3.card.appendChild(f.enabled.el);
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
      var delBtn = button('删除', 'danger', function () { doDelete(); });
      btnRow.appendChild(testBtn);
      btnRow.appendChild(saveBtn);
      btnRow.appendChild(delBtn);
      g4.card.appendChild(btnRow);
      body.appendChild(g4.wrap);

      ctx.setActions([
        { label: '保存', kind: 'primary', onClick: function () { doSave(); } },
        { label: '删除', kind: 'danger', onClick: function () { doDelete(); } }
      ]);

      function collect() {
        return {
          id: params.id,
          name: f.name.get() || '',
          baseUrl: f.baseUrl.get(),
          apiKey: f.apiKey.get(),
          model: f.model.get(),
          temperature: f.temperature.get(),
          maxTokens: f.maxTokens.getNum(),
          contextMessages: f.contextMessages.getNum(),
          timeoutSec: f.timeoutSec.getNum(),
          stream: f.stream.get(),
          enabled: f.enabled.get()
        };
      }

      function doSave() {
        var next = collect();
        var idx = list.findIndex(function (it) { return it.id === next.id; });
        if (idx >= 0) list[idx] = next;
        var ok = store.set('subApis', list);
        if (ok) {
          ctx.toast('已保存', 'ok');
          ctx.back();
        } else {
          ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
        }
      }

      function doTest() {
        var next = collect();
        testBtn.disabled = true;
        saveBtn.disabled = true;
        delBtn.disabled = true;
        testBox.className = 'test-result is-loading';
        testBox.innerHTML = '';
        testBox.appendChild(h('p', 'test-title', '正在连…'));
        testBox.appendChild(h('p', 'test-tip', normalizeEndpoint(next.baseUrl) || '接口地址是空的'));

        runTest(next).then(function (res) {
          renderTestResult(testBox, res);
          testBtn.disabled = false;
          saveBtn.disabled = false;
          delBtn.disabled = false;
          if (res.ok) ctx.toast('连上了 · ' + res.ms + 'ms', 'ok');
        });
      }

      function doDelete() {
        var idx = list.findIndex(function (it) { return it.id === params.id; });
        if (idx < 0) return;
        list.splice(idx, 1);
        var ok = store.set('subApis', list);
        if (ok) {
          ctx.toast('已删除', 'ok');
          ctx.back();
        } else {
          ctx.toast('删除失败', 'err');
        }
      }
    }
  });
})(window);