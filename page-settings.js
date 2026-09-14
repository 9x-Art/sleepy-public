/* ============================================================
   page-settings.js — 设置
   依赖：store.js、ui.js、app.js（必须在它们之后加载）
   覆盖 ROADMAP：2.1 设置页框架 / 2.2 主 API 配置 + 测试连接 / 2.4 本地存储
   页面：settings → settings-model → settings-mainapi
         （settings-backup 在 page-backup.js 里注册）

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

      var g1 = group('模型与对话');
      var rowModel = row({
        label: '模型连接',
        hint: '主 API · 副 API · 后台任务',
        value: mainApiSummary(),
        onClick: function () { ctx.open('settings-model'); }
      });
      g1.card.appendChild(rowModel);
      g1.card.appendChild(row({
        label: '聊天默认参数',
        hint: '温度 · 上下文条数 · 流式 · 心声',
        onClick: function () { ctx.open('settings-chatdefaults'); }
      }));
      body.appendChild(g1.wrap);

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
      g5.card.appendChild(row({ label: '关于 Sleepy', hint: '2.18 版本 · 更新日志' }));
      body.appendChild(g5.wrap);

      var foot = h('p', 'set-foot', '');
      body.appendChild(foot);

      /* 刷新闭包挂在 ctx 上，onShow 直接调。
         只改文字、不重建 DOM，从下级页返回时滚动位置不会丢。 */
      ctx.refreshSummary = function () {
        setRowValue(rowModel, mainApiSummary());
        setRowValue(rowData, usageText());
        foot.textContent = '灰着的行是还没贴好的 · 当前存档 ' + usageText();
      };
      ctx.refreshSummary();
    },
    onShow: function (ctx) { if (ctx.refreshSummary) ctx.refreshSummary(); }
  });

  /* ================ 页面：聊天默认参数（二级） ================
     A6。这里的值是所有对话的默认；单个接口自己填了生成参数时以接口为准
     （api.js 的 genParams 就是这个优先级）。

     验收要的是「改了这里，实际请求里真的带上」，所以改完必须真发一条消息
     去核请求体 —— 页面显示对了不算过。 */
  Sleepy.register('settings-chatdefaults', {
    title: '聊天默认参数',
    render: function (ctx) {
      var body = ctx.body;
      var cfg = store.get('chatDefaults') || {};
      var f = {};

      /* 这里的值不能留空：它就是最下面那一层兜底，留空等于什么都没设。
         所以空输入一律填回默认值，而不是往下传一个 null。 */
      function num(field, fallback) {
        var v = field.get();
        return v == null ? fallback : v;
      }

      var g1 = group('生成', '所有对话的默认值。某个接口自己填了生成参数时，以那个为准。');
      f.temperature = numField({
        label: '温度',
        hint: '越高越发散；想让角色的反应更稳就往下调',
        value: cfg.temperature, min: 0, max: 2, step: 0.05
      });
      g1.card.appendChild(f.temperature.el);
      f.maxTokens = numField({ label: '单次回复上限', value: cfg.maxTokens, min: 64, max: 32768, step: 64 });
      g1.card.appendChild(f.maxTokens.el);
      f.contextMessages = numField({
        label: '携带上下文条数',
        hint: '越多越记得住，也越贵',
        value: cfg.contextMessages, min: 2, max: 200, step: 2
      });
      g1.card.appendChild(f.contextMessages.el);
      body.appendChild(g1.wrap);

      var g2 = group('开关');
      f.stream = switchField({
        label: '流式输出',
        hint: '打字机效果。关掉就会等整段一起出现',
        value: cfg.stream
      });
      g2.card.appendChild(f.stream.el);
      body.appendChild(g2.wrap);

      var g3 = group('心声', '跟着每次回复一起产出，一轮一条，不额外占一次生成额度。');
      f.heartbeatAuto = switchField({ label: '回复时附带心声', value: cfg.heartbeatAuto });
      g3.card.appendChild(f.heartbeatAuto.el);
      body.appendChild(g3.wrap);

      var btnRow = h('div', 'btn-row');
      btnRow.appendChild(button('填回默认值', 'ghost', function () { restore(); }));
      btnRow.appendChild(button('保存', 'primary', function () { save(); }));
      body.appendChild(btnRow);

      body.appendChild(h('p', 'set-foot',
        '改完点保存。下一个请求就会带上新参数。'));

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { save(); } }]);

      function collect() {
        return {
          temperature: num(f.temperature, 0.85),
          maxTokens: Math.round(num(f.maxTokens, 1024)),
          contextMessages: Math.round(num(f.contextMessages, 20)),
          stream: f.stream.get(),
          heartbeatAuto: f.heartbeatAuto.get()
        };
      }

      function save() {
        var ok = store.set('chatDefaults', collect());
        if (ok) ctx.toast('已保存，下一条消息就生效', 'ok');
        else ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
      }

      /* 填回默认值但不直接落盘 —— 让用户看见改了什么，再自己按保存 */
      function restore() {
        var def = store.defaults().chatDefaults;
        f.temperature.input.value = String(def.temperature);
        f.maxTokens.input.value = String(def.maxTokens);
        f.contextMessages.input.value = String(def.contextMessages);
        f.stream.input.checked = !!def.stream;
        f.heartbeatAuto.input.checked = !!def.heartbeatAuto;
        ctx.toast('已填回默认值，记得保存', 'ok');
      }
    }
  });

  /* ==================== 页面：模型连接（二级） ==================== */

  Sleepy.register('settings-model', {
    title: '模型连接',
    render: function (ctx) {
      var body = ctx.body;

      var g = group('对话');
      var rowMain = row({
        label: '主 API',
        hint: '日常对话走这一个',
        badge: mainApiSummary(),
        badgeKind: (mainApiSummary() === '已配置') ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-mainapi'); }
      });
      g.card.appendChild(rowMain);

      var subText = subApiSummary();
      var rowSub = row({
        label: '副 API',
        hint: '主 API 挂了就按顺序轮询这些',
        badge: subText,
        badgeKind: (subText === '未配置') ? 'dim' : 'ok',
        onClick: function () { ctx.open('settings-subapi'); }
      });
      g.card.appendChild(rowSub);
      body.appendChild(g.wrap);

      var g2 = group('后台任务');
      g2.card.appendChild(row({ label: '向量记忆 API', hint: '2.13 填 embedding 模型，不是对话模型' }));
      g2.card.appendChild(row({ label: '总结 API', hint: '2.14 便宜模型跑记忆抽取' }));
      body.appendChild(g2.wrap);

      var g3 = group('以后再说');
      g3.card.appendChild(row({ label: '语音 TTS', hint: '2.15' }));
      g3.card.appendChild(row({ label: '生图', hint: '2.16' }));
      g3.card.appendChild(row({ label: '天气 / 搜索 / WebDAV', hint: '2.17' }));
      body.appendChild(g3.wrap);

      body.appendChild(h('p', 'set-foot',
        '所有 Key 只存在这台设备的浏览器里，不经过我的服务器。'));

      /* 从副 API 页返回时刷新徽标：只改文字，不重建 DOM */
      ctx.refreshSummary = function () {
        setRowValue(rowMain, mainApiSummary());
        setRowValue(rowSub, subApiSummary());
      };
    },
    onShow: function (ctx) { if (ctx.refreshSummary) ctx.refreshSummary(); }
  });

  /* ==================== 页面：主 API（三级） ==================== */

  Sleepy.register('settings-mainapi', {
    title: '主 API',
    render: function (ctx) {
      var body = ctx.body;
      var cfg = store.get('mainApi');
      var f = {};

      var g = group('接口');
      f.name = textField({ label: '备注名', value: cfg.name, placeholder: '主模型' });
      g.card.appendChild(f.name.el);

      f.baseUrl = textField({
        label: '接口地址 Base URL',
        hint: '填到 /v1 就行，测试时会自动补 /chat/completions',
        value: cfg.baseUrl,
        placeholder: 'https://api.example.com/v1',
        inputmode: 'url'
      });
      g.card.appendChild(f.baseUrl.el);

      f.apiKey = textField({
        label: 'API Key',
        hint: '明文存在本机浏览器，换设备不会跟着走',
        value: cfg.apiKey,
        placeholder: 'sk-...',
        password: true
      });
      g.card.appendChild(f.apiKey.el);

      f.model = textField({
        label: '模型名',
        value: cfg.model,
        placeholder: '例如 gpt-4o-mini / deepseek-chat'
      });
      g.card.appendChild(f.model.el);
      body.appendChild(g.wrap);

      var g2 = group('生成参数', '留空就是跟随「聊天默认参数」。只有这一个接口想特殊化时才填，填了就以这里为准。');
      f.temperature = numField({ label: '温度', hint: '留空＝跟随默认 · 越高越发散', value: cfg.temperature, min: 0, max: 2, step: 0.05 });
      g2.card.appendChild(f.temperature.el);
      f.maxTokens = numField({ label: '单次回复上限', hint: '留空＝跟随默认', value: cfg.maxTokens, min: 64, max: 32768, step: 64 });
      g2.card.appendChild(f.maxTokens.el);
      f.contextMessages = numField({ label: '携带上下文条数', hint: '留空＝跟随默认 · 越多越记得住，也越贵', value: cfg.contextMessages, min: 2, max: 200, step: 2 });
      g2.card.appendChild(f.contextMessages.el);
      f.timeoutSec = numField({ label: '超时（秒）', value: cfg.timeoutSec, min: 5, max: 300, step: 5 });
      g2.card.appendChild(f.timeoutSec.el);
      body.appendChild(g2.wrap);

      var g3 = group('开关');
      f.stream = switchField({
        label: '流式输出',
        hint: '打字机效果。总开关在「聊天默认参数」，这里关掉＝这个接口不走流式',
        value: cfg.stream
      });
      g3.card.appendChild(f.stream.el);
      f.enabled = switchField({ label: '启用这个接口', value: cfg.enabled });
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
        var ok = store.set('mainApi', next);
        if (ok) ctx.toast('已保存', 'ok');
        else ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
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

})(window);
