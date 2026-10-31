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

      /* 数字化的下限兜底：cfg.timeoutSec 可能是 0，也可能是字符串 '0'（老存档）。
         后者是 truthy —— `cfg.timeoutSec || 60` 拦不住它，会被
         Math.max(1, '0') 算成 **1 秒**（2026-09-23 全链路排查）。
         2026-09-29 起下限抬到 60（用户拍板「归一到 60s」），与 genParams 同口径。 */
      var secs = Number(cfg.timeoutSec);
      if (!(secs >= 60)) secs = 60;
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
        badge: mainApiSummary(),
        badgeKind: (mainApiSummary() === '已配置') ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-mainapi'); }
      });
      gTalk.card.appendChild(rowMain);

      var subText = subApiSummary();
      var rowSub = row({
        label: '副 API',
        badge: subText,
        badgeKind: (subText === '未配置') ? 'dim' : 'ok',
        onClick: function () { ctx.open('settings-subapi'); }
      });
      gTalk.card.appendChild(rowSub);
      body.appendChild(gTalk.wrap);

      /* ============ 语音（2.15）============
         2026-09-22 接上：语音也是有「服务 + 连接 + 默认档位」的一等公民，
         所以它跟主/副 API 一样紧跟着摆在设置页面上，不埋在「其他能力」里。
         角色级的音色 / 频率 / 表达在「角色语音」页（角色骨架页与对话设置里都能进）。 */
      var gVoice = group('语音');
      var rowTts = row({
        label: '语音 TTS',
        badge: Sleepy.tts ? Sleepy.tts.summary() : '未接',
        badgeKind: (Sleepy.tts && Sleepy.tts.settings().enabled) ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-tts'); }
      });
      gVoice.card.appendChild(rowTts);
      body.appendChild(gVoice.wrap);

      /* ============ 其他能力 ============
         还没接的那些也摆在这儿 —— 占位要摆在对的位置，
         不然用户根本不知道这 App 以后能长成什么样。灰着的行点不动。 */
      var gCap = group('其他能力');
      /* 向量与总结这两个都是**单份接口**（不像副 API 那样多组轮询），
         2026-09-22 接上；空着的时候：总结跟随主 API，向量没配就没配。
         行要留引用：从它们的配置页回来时 badge 得跟着变（见 refreshSummary）。 */
      var capRows = {};
      [
        { label: '向量记忆 API', kind: 'vector' },
        { label: '总结 API', kind: 'summary' },
        { label: '视频理解 API', kind: 'video' }
      ].forEach(function (c) {
        var cfg = Sleepy.singleApi ? Sleepy.singleApi.cfgOf(c.kind) : null;
        capRows[c.kind] = row({
          label: c.label,
          badge: cfg ? (cfg.model || '已配置') : '未配置',
          badgeKind: cfg ? 'ok' : 'dim',
          onClick: function () { ctx.open('settings-' + c.kind); }
        });
        gCap.card.appendChild(capRows[c.kind]);
      });
      /* 生图已经接上了（page-imggen.js）—— 用户：「不开独立 App，从设置进」 */
      var rowImg = row({
        label: '生图',
        badge: Sleepy.imggen ? Sleepy.imggenSummary() : '未配置',
        badgeKind: (Sleepy.imggen && Sleepy.imggenSummary() !== '未配置') ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-imggen'); }
      });
      gCap.card.appendChild(rowImg);
      /* 天气感知 / 链接解析（2026-10-06 接上，不再是灰占位） */
      var vpKey = '';
      try { vpKey = String(store.get('vpKey') || ''); } catch (e) { /* 没有就算了 */ }
      gCap.card.appendChild(row({
        label: '天气感知',
        onClick: function () { ctx.open('settings-weblink'); }
      }));
      gCap.card.appendChild(row({
        label: '链接解析',
        badge: vpKey ? '已填 Key' : '匿名额度',
        badgeKind: vpKey ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-videoparse'); }
      }));
      body.appendChild(gCap.wrap);

      /* 世界书（B 模块）是首页 App，不挂设置 —— 它跟名片夹一样，
         是「用户自己往里加东西」的地方，设置里只放引擎怎么连。 */

      /* 「主题与字号」这行删掉了（2026-10-05，用户）：外观 App 里全能设，
         设置页不再放第二份 —— 原位置给了 MCP（2026-10-06 接上真页面）。 */
      var gMcp = group('MCP');
      var rowMcp = row({
        label: 'MCP 连接',
        badge: Sleepy.mcp ? Sleepy.mcp.summary() : '未接',
        badgeKind: (Sleepy.mcp && Sleepy.mcp.summary() !== '未配置') ? 'ok' : 'dim',
        onClick: function () { ctx.open('settings-mcp'); }
      });
      gMcp.card.appendChild(rowMcp);
      body.appendChild(gMcp.wrap);

      /* 角色相关的入口（原来的「人设预设库」）不在这里 ——
         它本来就是「新增角色」，已经搬到首页的名片夹。 */

      var g4 = group('数据与备份');
      var rowData = row({
        label: '数据与备份',
        value: usageText(),
        onClick: function () { ctx.open('settings-backup'); }
      });
      g4.card.appendChild(rowData);
      body.appendChild(g4.wrap);

      var g5 = group('其他');
      /* 检查更新（2026-10-25 安卓壳）：只在原生 App 里出现 —— 浏览器/PWA
         的更新就是刷新页面，不用这行。桥的 checkUpdate 异步拉 version.json
         比对构建号，结果经 __sleepyUpdateResult 回 toast（含失败原因）。 */
      if (window.SleepyNative && typeof window.SleepyNative.checkUpdate === 'function') {
        var updRow = row({
          label: '检查更新',
          value: (window.SleepyNative.getInfo && window.SleepyNative.getInfo().build) || ''
        });
        updRow.disabled = false;
        updRow.classList.remove('is-soon');
        updRow.addEventListener('click', function () {
          ctx.toast('正在检查更新…');
          window.SleepyNative.checkUpdate();
        });
        g5.card.appendChild(updRow);
      }
      /* 我的授权（账密系统 v2，2026-10-21；2026-10-23 起进门先过授权闸）——
         能走到设置页说明已激活，这页只剩管理：改密 / 设备 / 注销
         （激活 / 登录表单只活在启动闸上，page-license 两处共用一份）。 */
      var licRow = row({ label: '我的授权' });
      licRow.disabled = false;
      licRow.classList.remove('is-soon');
      licRow.addEventListener('click', function () { ctx.open('license'); });
      g5.card.appendChild(licRow);

      /* 用户协议 / 隐私政策（2026-10-07）：首启弹过一次之后，**这里必须留一个
         随时能翻回去的入口** —— 只在第一次弹是耍流氓，用户要能自己再查。
         两行分开放，各看一份，标题写清是什么。 */
      var legalRowA = row({
        label: '用户协议',
        onClick: function () {
          if (Sleepy.legal && Sleepy.legal.openDoc) Sleepy.legal.openDoc('user');
          else ctx.toast('这一版没有协议页', 'err');
        }
      });
      var legalRowP = row({
        label: '隐私政策',
        onClick: function () {
          if (Sleepy.legal && Sleepy.legal.openDoc) Sleepy.legal.openDoc('priv');
          else ctx.toast('这一版没有隐私政策', 'err');
        }
      });
      g5.card.appendChild(legalRowA);
      g5.card.appendChild(legalRowP);
      /* 「关于 Sleepy」背着隐蔽开关：3 秒内连点 5 次 = 切开发者模式。
         面向用户后内置 prompt 上锁，这个开关是唯一的解锁口 ——
         所以它不能像普通开关一样摆在明面上（用户：「隐蔽一些qwq」）。
         row() 不带 onClick 会把自己 disabled 掉，这里手动解开再挂事件。 */
      var aboutRow = row({ label: '关于 Sleepy' });
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
        /* 单份接口那两行（总结 / 向量）：从它们的配置页回来必须跟着变 ——
           不刷新的话就是「明明配好了，回到设置页还写着未配置」（真机抓到的）。 */
        ['vector', 'summary', 'video'].forEach(function (k) {
          if (!capRows[k]) return;
          var c = Sleepy.singleApi ? Sleepy.singleApi.cfgOf(k) : null;
          setRowBadge(capRows[k], c ? (c.model || '已配置') : '未配置', c ? 'ok' : 'dim');
        });
        /* MCP 行（2026-10-06）：从配置页回来时 badge 跟着变 */
        if (Sleepy.mcp && rowMcp) {
          var ms2 = Sleepy.mcp.summary();
          setRowBadge(rowMcp, ms2, ms2 === '未配置' ? 'dim' : 'ok');
        }
        setRowValue(rowData, usageText());
        /* 语音那行同理：从语音设置页回来，开关 / 连接状态得跟着变 */
        if (Sleepy.tts && rowTts) {
          var on = Sleepy.tts.settings().enabled;
          setRowBadge(rowTts, Sleepy.tts.summary(), on ? 'ok' : 'dim');
        }
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

    /* 拉取模型：模型名旁边的小圆钮，用表单里当前的地址和 Key，不用先保存。
       结果是**浮层**（ui.modelPickButton → ui.modelPicker），不是铺在页面里 ——
       拉一次可能回 60 个模型名，铺在页面里整页会被拉得很长，用户得一直往下滚
       **整页**（用户原话：「现在是直接全部铺在屏幕上，就会很长」）。
       浮层里自己滚 + 顶部搜索框，点一个填进去、框随即收掉。 */
    var mini = ui.modelPickButton({
      load: function () {
        return Sleepy.api.fetchModels({ baseUrl: f.baseUrl.get(), apiKey: f.apiKey.get() });
      },
      onPick: function (id) { f.model.input.value = id; }
    });
    f.model.el.querySelector('.set-line').appendChild(mini);

    return f;
  }

  /* ==================== 页面：主 API（预设列表） ==================== */

  Sleepy.register('settings-mainapi', {
    title: '主 API',
    render: function (ctx) {
      var body = ctx.body;

      var g = group('主 API 预设');
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
    /* 生成参数的内置默认值只看 api.js 那一份（GEN_DEFAULTS）——
       store 的 chatDefaults 里已经不放生成参数了（见 store.js 的迁移注释）。 */
    var def = Sleepy.api.genDefaults;
    var f = {};

    var g = group('接口');
    f = buildApiFields(g.card, preset);

    var g2 = group('生成参数');
    f.temperature = numField({ label: '温度', hint: '留空＝用内置默认 · 越高越发散', value: preset.temperature, min: 0, max: 2, step: 0.05 });
    f.temperature.input.placeholder = String(def.temperature);
    g2.card.appendChild(f.temperature.el);
    f.maxTokens = numField({ label: '单次回复上限', hint: '留空＝用内置默认', value: preset.maxTokens, min: 64, max: 32768, step: 64 });
    f.maxTokens.input.placeholder = String(def.maxTokens);
    g2.card.appendChild(f.maxTokens.el);
    f.contextMessages = numField({ label: '携带上下文条数', hint: '留空＝用内置默认 · 越多越记得住，也越贵', value: preset.contextMessages, min: 2, max: 200, step: 2 });
    f.contextMessages.input.placeholder = String(def.contextMessages);
    g2.card.appendChild(f.contextMessages.el);
    f.timeoutSec = numField({ label: '超时（秒）', hint: '最小 60 —— 小于 60 的值运行时也会按 60 跑', value: preset.timeoutSec, min: 60, max: 300, step: 5 });
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
        maxTokens: f.maxTokens.getNum(),
        contextMessages: f.contextMessages.getNum(),
        timeoutSec: f.timeoutSec.getNum(),
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
      var def = Sleepy.api.genDefaults;
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

  /* ==================== 页面：MCP 服务列表（2026-10-06） ==================== */

  Sleepy.register('settings-mcp', {
    title: 'MCP 连接',
    render: function (ctx) {
      var body = ctx.body;
      var g = group('MCP 服务');

      function refresh() {
        g.card.innerHTML = '';
        var list = Sleepy.mcp ? Sleepy.mcp.list() : [];
        if (!list.length) {
          g.card.appendChild(row({ label: '还没有服务，点下面添加', plain: true }));
        }
        list.forEach(function (c) {
          var on = 0;
          (c.tools || []).forEach(function (t) {
            if ((c.toolOn || {})[t.name] === true) on++;
          });
          g.card.appendChild(row({
            label: c.name || '未命名服务',
            hint: (c.transport === 'sse' ? 'SSE' : 'HTTP') + ' · 开着 ' + on + ' 个工具' +
              (c.lastError ? ' · 上次出错' : ''),
            badge: c.enabled ? '开' : '关',
            badgeKind: c.enabled ? 'ok' : 'dim',
            onClick: function () { ctx.open('settings-mcp-edit', { id: c.id }); }
          }));
        });
        g.card.appendChild(row({
          label: '添加服务',
          onClick: function () { ctx.open('settings-mcp-edit', {}); }
        }));
      }
      refresh();
      body.appendChild(g.wrap);

      body.appendChild(h('p', 'set-foot',
        '网页只能连 SSE / streamable HTTP 型的 MCP 服务（本地 stdio 的等以后 APK 版）；' +
        '服务需要允许跨域（CORS）。所有 Token 只存这台设备。'));

      ctx.rebuild = refresh;
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* ==================== 页面：MCP 服务编辑（新增 / 编辑共用） ==================== */

  Sleepy.register('settings-mcp-edit', {
    title: 'MCP 服务',
    render: function (ctx) {
      var id = ctx.params.id || '';
      var isNew = !id;
      var cfg = isNew
        ? { id: '', name: '', url: '', token: '', transport: 'http', enabled: true, tools: [], toolOn: {} }
        : (Sleepy.mcp ? Sleepy.mcp.cfgOf(id) : null);
      if (!isNew && !cfg) {
        ctx.toast('找不到这条配置', 'err');
        ctx.back();
        return;
      }
      if (isNew) ctx.setTitle('添加 MCP 服务');

      var body = ctx.body;
      var f = {};

      /* ---- 服务 ---- */
      var g1 = group('服务');
      f.name = textField({ label: '名称', hint: '自己认得就行', value: cfg.name || '' });
      g1.card.appendChild(f.name.el);
      f.url = textField({
        label: '服务地址',
        hint: 'HTTP 型填 MCP 端点；SSE 型填 SSE 端点',
        value: cfg.url || ''
      });
      g1.card.appendChild(f.url.el);
      f.token = textField({
        label: 'Token（可选）',
        hint: '要鉴权的服务填 Bearer Token，随请求带上',
        value: cfg.token || ''
      });
      g1.card.appendChild(f.token.el);
      f.sse = switchField({
        label: '用旧版 SSE 连接',
        hint: '关 = streamable HTTP（新版，默认）；开 = 旧版 HTTP+SSE。连不上就换一挡试试',
        value: cfg.transport === 'sse'
      });
      g1.card.appendChild(f.sse.el);
      body.appendChild(g1.wrap);

      /* ---- 开关 ---- */
      var g2 = group('开关');
      f.enabled = switchField({
        label: '启用这个服务',
        hint: '总开关 —— 关了，它的工具在任何对话里都不出现',
        value: cfg.enabled !== false
      });
      g2.card.appendChild(f.enabled.el);
      body.appendChild(g2.wrap);

      /* ---- 工具清单（只有编辑已保存的服务才有） ---- */
      var g3 = group('工具');
      var toolsCard = g3.card;
      var toolsHint = null;
      function paintTools() {
        toolsCard.innerHTML = '';
        var cur = (!isNew && Sleepy.mcp) ? Sleepy.mcp.cfgOf(cfg.id) : null;
        var tools = (cur && cur.tools) || [];
        if (isNew) {
          toolsCard.appendChild(row({ label: '先保存，再「刷新工具」', plain: true }));
          return;
        }
        if (!tools.length) {
          toolsCard.appendChild(row({
            label: cur && cur.lastError ? ('上次没拉到：' + cur.lastError) : '还没拉过工具清单',
            plain: true
          }));
        }
        tools.forEach(function (t) {
          var sw = switchField({
            label: t.name,
            hint: (t.description || '').slice(0, 80) || '（这个工具没有说明）',
            value: (cur.toolOn || {})[t.name] === true
          });
          sw.input.addEventListener('change', function () {
            Sleepy.mcp.toggleTool(cfg.id, t.name, sw.get());
          });
          toolsCard.appendChild(sw.el);
        });
        /* 同步行注：拉到了几个、上次什么时候 */
        if (toolsHint) {
          toolsHint.textContent = tools.length
            ? '共 ' + tools.length + ' 个工具 · 上次刷新 ' +
              (cur.lastSync ? new Date(cur.lastSync).toLocaleTimeString() : '—')
            : '';
        }
      }
      toolsHint = h('p', 'cap-hint', '');
      paintTools();
      body.appendChild(g3.wrap);

      /* ---- 测试 / 保存 ---- */
      var g4 = group('连接');
      var testBox = h('div', 'test-result is-idle');
      testBox.appendChild(h('p', 'test-title', '还没连过'));
      g4.card.appendChild(testBox);
      var btnRow = h('div', 'btn-row');
      var refreshBtn = button('保存并刷新工具', 'ghost', function () { doSave(true); });
      var saveBtn = button('保存', 'primary', function () { doSave(false); });
      btnRow.appendChild(refreshBtn);
      btnRow.appendChild(saveBtn);
      if (!isNew) {
        btnRow.appendChild(button('删除', 'danger', function () {
          ui.confirm({
            title: '删掉「' + (cfg.name || '这个服务') + '」？',
            text: '它的工具开关也会一起没。',
            ok: '删掉'
          }).then(function (yes) {
            if (!yes) return;
            Sleepy.mcp.remove(cfg.id);
            ctx.toast('删掉了', 'ok');
            ctx.back();
          });
        }));
      }
      g4.card.appendChild(btnRow);
      body.appendChild(g4.wrap);

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(false); } }]);

      function doSave(alsoRefresh) {
        var r = Sleepy.mcp.upsert({
          id: cfg.id || undefined,
          name: f.name.get ? f.name.get() : f.name.input.value,
          url: f.url.get ? f.url.get() : f.url.input.value,
          token: f.token.get ? f.token.get() : f.token.input.value,
          transport: f.sse.get() ? 'sse' : 'http',
          enabled: f.enabled.get()
        });
        if (!r.ok) { ctx.toast(r.error || '没存上', 'err'); return; }
        cfg.id = r.cfg.id;
        if (!alsoRefresh) {
          ctx.toast('已保存', 'ok');
          paintTools();
          return;
        }
        testBox.querySelector('.test-title').textContent = '正在连接…';
        Sleepy.mcp.refreshTools(cfg.id).then(function (rr) {
          if (rr.ok) {
            testBox.querySelector('.test-title').textContent =
              '连上了 · 拉到 ' + (rr.tools ? rr.tools.length : 0) + ' 个工具';
            ctx.toast('工具清单已更新', 'ok');
          } else {
            testBox.querySelector('.test-title').textContent = '没连上：' + (rr.error || '未知错误');
            ctx.toast('连接失败：' + (rr.error || '未知错误'), 'err');
          }
          paintTools();
        });
      }
    }
  });

  /* ==================== 页面：天气感知 ====================

     2026-10-06 三次定稿：**只做天气感知**（热点已按用户裁决撤掉，也不注入），
     数据源 OpenWeatherMap 免费层（key 免费注册）；char 的搜索能力走 MCP 工具
     （实测免鉴权、开 CORS 的通用搜索接口为零）。WebDAV 不接。 */
  Sleepy.register('settings-weblink', {
    title: '天气感知',
    render: function (ctx) {
      var body = ctx.body;
      var wl = Sleepy.core.weblink;
      var cfg = wl.cfg();

      var g = group('现实天气感知');
      var fRw = switchField({
        label: '注入天气',
        hint: 'TA 在线上聊天能感知你那边的现实天气',
        value: cfg.rwOn === true
      });
      g.card.appendChild(fRw.el);
      var fCity = textField({
        label: '城市',
        hint: '如 上海 / Shanghai'
      });
      fCity.input.value = cfg.weatherCity || '';
      g.card.appendChild(fCity.el);
      var fKey = textField({
        label: 'OpenWeatherMap Key',
        hint: '免费注册（免费层够用）'
      });
      fKey.input.value = String(cfg.owmKey || '');
      g.card.appendChild(fKey.el);
      var btnRow = h('div', 'btn-row');
      btnRow.appendChild(button('注册页', 'ghost', function () {
        try { window.open('https://openweathermap.org/api', '_blank'); } catch (e) { /* 拦就拦 */ }
      }));
      btnRow.appendChild(button('保存', 'primary', function () {
        wl.set({ rwOn: fRw.get(), weatherCity: fCity.get(), owmKey: fKey.get() });
        ctx.toast('存好了', 'ok');
        ctx.back();
      }));
      g.card.appendChild(btnRow);
      body.appendChild(g.wrap);
    }
  });

  /* ==================== 页面：链接解析 ====================

     聊天里平台链接卡（微博/抖音/B站等，不只视频）的富数据从
     极数本源（apizero.cn）的 video-parse 接口来：浏览器直连（CORS 全开），
     匿名 5 次/天/IP，填自己的 key 提额。 */
  Sleepy.register('settings-videoparse', {
    title: '链接解析',
    render: function (ctx) {
      var body = ctx.body;
      var g = group();
      var f = textField({
        label: 'API Key（可选）',
        hint: '不填每天 5 次，填自己的提额'
      });
      f.input.value = String(store.get('vpKey') || '');
      g.card.appendChild(f.el);
      var fCustom = textField({
        label: '自定义接口（可选）',
        hint: '填了优先用它；URL 模板，{url} 是占位'
      });
      fCustom.input.value = String(store.get('vpCustomApi') || '');
      g.card.appendChild(fCustom.el);
      var btnRow = h('div', 'btn-row');
      btnRow.appendChild(button('注册页', 'ghost', function () {
        try { window.open('https://apizero.cn', '_blank'); } catch (e) { /* 拦就拦 */ }
      }));
      btnRow.appendChild(button('保存', 'primary', function () {
        store.set('vpKey', f.get());
        store.set('vpCustomApi', fCustom.get());
        store.set('vpCache', {});   /* 换了源，旧缓存作废 */
        ctx.toast('存好了', 'ok');
        ctx.back();
      }));
      g.card.appendChild(btnRow);
      body.appendChild(g.wrap);
    }
  });

})(window);
