/* ============================================================
   page-singleapi.js — 单份接口配置（总结 API / 向量记忆 API）
   依赖：store.js、ui.js、api.js、app.js（必须在它们之后加载）
   页面：settings-summary（总结 API）→ settings-vector（向量记忆 API）

   为什么是「单份」而不是像副 API 那样多组轮询：
   这两个都是**固定职责的便宜模型** —— 一个抽记忆、一个算向量。
   它们不需要多组容灾，而且协议和对话模型不一样：向量走 /embeddings，
   把对话模型喂给 /embeddings 只会 404。

   ★ 与副 API 的关系（用户 2026-09-22 拍板，三条都要成立）：
     · 新增副 API 时，如果这两份**还是空的**，顺手带一份进来（省得重填）
     · 填过之后两边各自独立：改副 API 不动它
     · 删副 API 也不动它（**不回落、不清空**）
   实现落在 page-subapi.js 的保存处 + 这里的 `seedFromSub()`。

   ★ 空 = 跟随主 API（总结）；**向量没有回落** —— 没配就是没配，
     绝不偷偷拿主 API 去发一个注定 404 的请求（那会变成「没配也在烧钱」）。
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
  var button = ui.button;
  var switchField = ui.switchField;

  /* 两种接口的全部差异就这几行 —— 其余 UI 与逻辑完全共用 */
  var KINDS = {
    summary: {
      key: 'summaryApi',
      title: '总结 API',
      eyebrow: 'MEMORY EXTRACTION',
      hint: '记忆抽取用的模型。这活是**批量、长文本、要稳不要个性**的，' +
        '拿主 API（通常是贵的对话模型）跑很浪费 —— 给它一个便宜的就够了。',
      modelHint: '填一个便宜的对话模型（比如 Haiku / 小模型 / 本地模型）',
      placeholder: 'gpt-4o-mini',
      fallback: '还没配 · 现在跟随主 API。',
      testChat: true
    },
    vector: {
      key: 'vectorApi',
      title: '向量记忆 API',
      eyebrow: 'EMBEDDINGS',
      hint: '把「原话与事件」变成可检索的向量。它只算向量、不说话，' +
        '所以要填 **embedding 模型**，不是对话模型。',
      modelHint: '必须填 embedding 模型（bge-m3 / text-embedding-3-small 这类）',
      placeholder: 'text-embedding-3-small',
      fallback: '还没配 —— 向量记忆需要它才能开。',
      testChat: false
    }
  };

  function cfgOf(kind) {
    var c = store.get(KINDS[kind].key);
    return (c && (c.baseUrl || c.model)) ? c : null;
  }

  function saveCfg(kind, patch) {
    var cur = cfgOf(kind) || { baseUrl: '', apiKey: '', model: '' };
    for (var k in patch) if (patch.hasOwnProperty(k)) cur[k] = patch[k];
    store.set(KINDS[kind].key, cur);
    return cur;
  }

  function clearCfg(kind) { store.set(KINDS[kind].key, null); }

  /* 从副 API 的某一组复制一份过来（新增副 API 时也会自动调这个）。
     只在**这边还是空的**时候填 —— 填过就不再覆盖（用户改过的东西不能丢）。 */
  function seedFromSub(kind) {
    if (cfgOf(kind)) return false;
    var list = store.get('subApis');
    if (!Array.isArray(list) || !list.length) return false;
    var src = list[0];
    if (!src || !src.baseUrl) return false;
    store.set(KINDS[kind].key, {
      baseUrl: src.baseUrl || '',
      apiKey: src.apiKey || '',
      model: src.model || '',
      seededFrom: src.name || '副 API'
    });
    return true;
  }

  /* 新增副 API 之后调一次：把空的总结 / 向量顺手填上。
     导出给 page-subapi.js 用（那边只管喊一声，不关心填了什么）。 */
  function seedAll() {
    var n = 0;
    if (seedFromSub('summary')) n++;
    if (seedFromSub('vector')) n++;
    return n;
  }

  /* ---------------------------- 测试 ---------------------------- */

  function testConn(kind, ctx) {
    var cfg = cfgOf(kind);
    if (!cfg) { ctx.toast('先把地址和模型填上', 'warn'); return; }
    var k = KINDS[kind];
    ctx.toast('正在测……');
    var p = k.testChat
      ? Sleepy.api.requestOnce({ cfg: cfg }, [{ role: 'user', content: '说一句「好」就行' }], { maxTokens: 8 })
        .then(function (res) {
          return res.ok ? { ok: true, text: '通了 · 回了「' + String(res.content || '').trim().slice(0, 20) + '」' }
            : { ok: false, text: Sleepy.api.describeError(res) };
        })
      : Sleepy.api.embed(cfg, ['测试']).then(function (res) {
        return res.ok ? { ok: true, text: '通了 · 返回 ' + res.dim + ' 维向量' }
          : { ok: false, text: Sleepy.api.describeError(res) };
      });
    return p.then(function (r) {
      ctx.toast(r.text, r.ok ? 'ok' : 'err');
      return r;
    });
  }

  /* ---------------------------- 绘制 ---------------------------- */

  function paint(ctx, kind) {
    var k = KINDS[kind];
    var cfg = cfgOf(kind);
    var body = ctx.body;
    body.innerHTML = '';
    ctx.setTitle(k.title);
    ctx.setActions([]);
    ctx.__paint = function () { paint(ctx, kind); };

    /* ---- 状态 ---- */
    var g0 = group('状态', '');
    g0.card.appendChild(row({
      label: cfg ? '已单独配置' : '还没配',
      hint: cfg ? (cfg.seededFrom ? ('从「' + cfg.seededFrom + '」带过来的一份，可以单独改') : '')
        : k.fallback
    }));
    body.appendChild(g0.wrap);

    /* ---- 说明 ---- */
    var g1 = group('这个接口干什么', k.hint);
    var gField = group('连接');

    var fields = {};
    fields.baseUrl = textField({
      label: '接口地址 Base URL',
      hint: kind === 'vector'
        ? '填到 /v1 就行，测试时会自动补 /embeddings'
        : '填到 /v1 就行，测试时会自动补 /chat/completions',
      value: cfg ? cfg.baseUrl : '',
      placeholder: 'https://api.example.com/v1',
      inputmode: 'url'
    });
    gField.card.appendChild(fields.baseUrl.el);

    fields.apiKey = textField({
      label: 'API Key',
      hint: '明文存在本机浏览器，换设备不会跟着走',
      value: cfg ? cfg.apiKey : '',
      placeholder: 'sk-...',
      password: true
    });
    gField.card.appendChild(fields.apiKey.el);

    fields.model = textField({
      label: '模型名',
      hint: k.modelHint,
      value: cfg ? cfg.model : '',
      placeholder: k.placeholder
    });
    gField.card.appendChild(fields.model.el);

    var acts = h('div', 'dl-actions');
    var save = button('保存', 'dl-btn is-primary', function () {
      var u = String(fields.baseUrl.get() || '').trim();
      var m = String(fields.model.get() || '').trim();
      if (!u || !m) { ctx.toast('地址和模型名都要填', 'warn'); return; }
      saveCfg(kind, {
        baseUrl: u, apiKey: String(fields.apiKey.get() || '').trim(), model: m,
        seededFrom: ''          /* 用户自己动过，就不再是「带过来的」了 */
      });
      ctx.toast('存好了');
      paint(ctx, kind);
    });
    var test = button('测试连接', 'dl-btn', function () { testConn(kind, ctx); });
    acts.appendChild(save);
    acts.appendChild(test);
    gField.card.appendChild(acts);
    body.appendChild(gField.wrap);
    body.appendChild(g1.wrap);

    /* ---- 向量记忆总开关（2026-09-22，只有向量这一页有）----
       配了接口 ≠ 要用：embedding 是花钱的，得有一把闸。
       开关**立即生效**（不用点保存）—— 它不是一个「接口配置」，
       是「用不用」这个行为本身。 */
    if (kind === 'vector') {
      var vc = store.get('vecCfg') || {};
      var gV = group('用不用', '索引存在这台设备的浏览器里（IndexedDB），不上传。关掉开关，索引也留着。');
      var fOn = switchField({
        label: '按话题找回聊过的东西',
        hint: '开着：每次说话前会先找一遍「以前聊过的相关片段」。关掉就只用已整理好的记忆和近期原文',
        value: vc.enabled !== false
      });
      fOn.input.addEventListener('change', function () {
        var cur = store.get('vecCfg') || {};
        cur.enabled = fOn.get();
        store.set('vecCfg', cur);
        ctx.toast(fOn.get() ? '下次说话就会用上' : '已关掉', 'ok');
      });
      gV.card.appendChild(fOn.el);

      /* 已经索引了多少段 —— 让用户看得见它在不在干活 */
      var statLine = h('p', 'set-group-note', '正在看索引…');
      gV.card.appendChild(statLine);
      if (Sleepy.memoryVec) {
        Sleepy.memoryVec.available().then(function (ok) {
          if (!ok) {
            statLine.textContent = '这台设备用不了 IndexedDB，向量记忆没法工作。';
            return;
          }
          return Sleepy.memoryVec.total().then(function (n) {
            statLine.textContent = n
              ? ('已经索引了 ' + n + ' 段对话。聊得越多，能找回来的越多。')
              : '还没有索引 —— 聊几轮之后就会自动开始（在后台跑，不挡聊天）。';
          });
        })['catch'](function () { statLine.textContent = ''; });
      } else {
        statLine.textContent = '';
      }
      body.appendChild(gV.wrap);
    }

    /* ---- 清空 ---- */
    var g2 = group('恢复默认',
      kind === 'summary'
        ? '清掉之后总结又跟着主 API 跑（费钱，但能跑）。'
        : '清掉之后向量记忆就没法用了 —— 它没有主 API 可回落。');
    var clear = button(kind === 'summary' ? '改回跟随主 API' : '清空这份配置', 'dl-btn is-danger', function () {
      if (!cfg) { ctx.toast('本来就是空的'); return; }
      clearCfg(kind);
      ctx.toast('清掉了');
      paint(ctx, kind);
    });
    g2.card.appendChild(clear);
    body.appendChild(g2.wrap);
  }

  Sleepy.register('settings-summary', {
    title: '总结 API',
    render: function (ctx) { paint(ctx, 'summary'); },
    onShow: function (ctx) { if (ctx.__paint) ctx.__paint(); }
  });

  Sleepy.register('settings-vector', {
    title: '向量记忆 API',
    render: function (ctx) { paint(ctx, 'vector'); },
    onShow: function (ctx) { if (ctx.__paint) ctx.__paint(); }
  });

  /* 给 page-subapi.js 用：新增副 API 后顺手把空的那两份填上 */
  Sleepy.singleApi = {
    KINDS: KINDS,
    cfgOf: cfgOf,
    saveCfg: saveCfg,
    clearCfg: clearCfg,
    seedFromSub: seedFromSub,
    seedAll: seedAll,
    testConn: testConn
  };

})(window);
