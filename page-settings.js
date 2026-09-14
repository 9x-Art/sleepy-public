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

  /* ======================= 页面：设置（一级） ======================= */

  Sleepy.register('settings', {
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

  /* ==================== 页面：模型连接（二级） ==================== */

  Sleepy.register('settings-model', {
    title: '模型连接',
    render: function (ctx) {
      var body = ctx.body;

      var summary = mainApiSummary();
      var g = group('对话');
      var g4 = group('数据与备份');
      g.card.appendChild(row({
        label: '主 API',
        hint: '日常对话走这一个',
        badge: summary,
        badgeKind: (summary === '已配置') ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-mainapi'); }
      }));
      g.card.appendChild(row({ label: '副 API', hint: '2.3 多组 + 轮询顺序 + 启用开关' }));
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
    }
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

      var g2 = group('生成参数');
      f.temperature = numField({ label: '温度', hint: '越高越发散', value: cfg.temperature, min: 0, max: 2, step: 0.05 });
      g2.card.appendChild(f.temperature.el);
      f.maxTokens = numField({ label: '单次回复上限', value: cfg.maxTokens, min: 64, max: 32768, step: 64 });
      g2.card.appendChild(f.maxTokens.el);
      f.contextMessages = numField({ label: '携带上下文条数', hint: '越多越记得住，也越贵', value: cfg.contextMessages, min: 2, max: 200, step: 2 });
      g2.card.appendChild(f.contextMessages.el);
      f.timeoutSec = numField({ label: '超时（秒）', value: cfg.timeoutSec, min: 5, max: 300, step: 5 });
      g2.card.appendChild(f.timeoutSec.el);
      body.appendChild(g2.wrap);

      var g3 = group('开关');
      f.stream = switchField({ label: '流式输出', hint: '打字机效果，聊天页用', value: cfg.stream });
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
