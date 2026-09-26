/* ============================================================
   page-singleapi.js — 单份接口配置（总结 API / 向量记忆 API）
   依赖：store.js、ui.js、api.js、app.js（必须在它们之后加载）

   页面：
     settings-summary（预设列表）→ settings-summary-add | settings-summary-edit
     settings-vector （一页表单，没有预设这一层）

   为什么这两个是「固定职责」而不是像副 API 那样多组轮询：
   一个抽记忆、一个算向量。它们不需要多组容灾去轮询。

   ★ 两者的界面**故意不一样**（用户 2026-09-23 明确）：
     · 总结 API：**多套预设 + 列表页 + 从副 API 复制一份**。
       它和副 API 都是对话模型（/chat/completions），复制过来就能用。
       存法照抄主 API：`summaryApis` 数组 + `summaryApiId` 指当前那套，
       老的 `summaryApi` 键继续镜像「当前那套」—— cfgOf() 只读镜像键，
       签名与行为都没变，page-summary / page-settings / smoke 全部无感。
     · 向量记忆 API：**单份、一页表单、不复制、不列表**。
       它要的是 embedding 模型，副 API 是对话模型，协议都不一样
       （/embeddings vs /chat/completions）—— 复制过来只会得到一份
       注定 404 的配置。所以它就是单个 `vectorApi`。

   ★ 与副 API 的关系（用户 2026-09-22 拍板，三条都要成立）：
     · 新增副 API 时，如果总结**还是空的**，顺手带一份进来（省得重填）
     · 填过之后两边各自独立：改副 API 不动它
     · 删副 API 也不动它（**不回落、不清空**）
     （**只有总结**会走这条 —— 见上面那条为什么向量不参与。）
     另外列表页给了**显式**的「从副 API 复制一份」：上面第一条只在
     「新增副 API」这个时机触发，用户手上早就有的副 API 永远等不到它。

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
  var textField = ui.textField;
  var button = ui.button;
  var switchField = ui.switchField;

  /* 两种接口的全部差异就这几行 —— 其余 UI 与逻辑完全共用 */
  var KINDS = {
    summary: {
      key: 'summaryApi',
      listKey: 'summaryApis',
      idKey: 'summaryApiId',
      title: '总结 API',
      defaultName: '总结模型',
      eyebrow: 'MEMORY EXTRACTION',
      hint: '记忆抽取用的模型。批量、长文本、要稳不要个性 —— ' +
        '给它一个便宜的就够了，不用拿贵的对话模型跑。',
      modelHint: '填一个便宜的对话模型（比如 Haiku / 小模型 / 本地模型）',
      placeholder: 'gpt-4o-mini',
      fallback: '还没配 · 现在跟随主 API。',
      testChat: true
    },
    /* 向量**不走预设、也不从副 API 复制**：它要的是 embedding 模型，
       副 API 是对话模型，协议都不一样（/embeddings vs /chat/completions）——
       带过来只会得到一份注定 404 的配置（用户 2026-09-23 明确）。
       所以它没有 listKey / idKey，页面是一页表单（renderSingle）。 */
    vector: {
      key: 'vectorApi',
      title: '向量记忆 API',
      defaultName: '向量模型',
      eyebrow: 'EMBEDDINGS',
      hint: '把「原话与事件」变成可检索的向量。它只算向量、不说话，' +
        '所以要填 embedding 模型，不是对话模型。',
      modelHint: '必须填 embedding 模型（bge-m3 / text-embedding-3-small 这类）',
      placeholder: 'text-embedding-3-small',
      fallback: '还没配 —— 向量记忆需要它才能开。',
      testChat: false
    }
  };

  /* ---------------------------- 预设读写 ---------------------------- */

  function presetsOf(kind) {
    var l = store.get(KINDS[kind].listKey);
    return Array.isArray(l) ? l : [];
  }

  function activeIdOf(kind) {
    var v = store.get(KINDS[kind].idKey);
    return v ? String(v) : '';
  }

  function savePresetsOf(kind, list) { return store.set(KINDS[kind].listKey, list); }

  function activePreset(kind) {
    var list = presetsOf(kind);
    var id = activeIdOf(kind);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 把「当前那套」镜像进老键（cfgOf / page-summary / memory-vec 只读它）。
     preset 为空 → 镜像也清空（= 没配）。 */
  function syncMirror(kind, preset) {
    if (!preset) { store.set(KINDS[kind].key, null); return false; }
    store.set(KINDS[kind].key, {
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      seededFrom: preset.seededFrom || ''
    });
    return true;
  }

  /* 切换「当前使用」并同步镜像 —— 页面与测试都走它，别手写「设 id + 同步」两步。
     id 传空字符串 = 显式「哪套都不用」，镜像跟着清掉。 */
  function setActive(kind, id) {
    store.set(KINDS[kind].idKey, id);
    var list = presetsOf(kind);
    var want = id ? String(id) : '';
    var cur = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === want) { cur = list[i]; break; }
    return syncMirror(kind, cur);
  }

  /* ---------------------------- 对外口子 ---------------------------- */

  /* cfgOf 只认镜像键 —— 这个签名是 page-summary / memory-vec / page-settings
     的消费口子，不能变。 */
  function cfgOf(kind) {
    var c = store.get(KINDS[kind].key);
    return (c && (c.baseUrl || c.model)) ? c : null;
  }

  /* 有 listKey 的走「多预设」（总结）；没有的是一份（向量）。 */
  function hasPresets(kind) { return !!KINDS[kind].listKey; }

  function saveCfg(kind, patch) {
    var k = KINDS[kind];
    /* 单份：直接写那个键，没有列表这一层 */
    if (!hasPresets(kind)) {
      var one = store.get(k.key) || { name: '', baseUrl: '', apiKey: '', model: '', seededFrom: '' };
      for (var q in patch) if (patch.hasOwnProperty(q)) one[q] = patch[q];
      store.set(k.key, one);
      return one;
    }
    var list = presetsOf(kind);
    var id = activeIdOf(kind);
    var cur = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { cur = list[i]; break; }
    if (!cur) {
      cur = newPreset(kind, { name: k.defaultName });
      list.push(cur);
      store.set(k.idKey, cur.id);
    }
    for (var p in patch) if (patch.hasOwnProperty(p)) cur[p] = patch[p];
    savePresetsOf(kind, list);
    syncMirror(kind, cur);
    return cur;
  }

  /* 「清空」：有预设的连预设一起清（否则会留下镜像为空、列表还有孤儿的状态）；
     单份的直接把那个键清掉。 */
  function clearCfg(kind) {
    var k = KINDS[kind];
    store.set(k.key, null);
    if (hasPresets(kind)) {
      store.set(k.listKey, []);
      store.set(k.idKey, '');
    }
  }

  /* ---------------------------- 从副 API 带一份 ---------------------------- */

  function newPreset(kind, patch) {
    var p = {
      id: kind + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: KINDS[kind].defaultName,
      baseUrl: '',
      apiKey: '',
      model: '',
      seededFrom: ''
    };
    for (var k in patch) if (patch.hasOwnProperty(k)) p[k] = patch[k];
    return p;
  }

  /* 副 API 的第一组，能不能拿来当来源 */
  function subSource() {
    var list = store.get('subApis');
    if (!Array.isArray(list) || !list.length) return null;
    var src = list[0];
    if (!src || !src.baseUrl) return null;
    return src;
  }

  function presetFromSub(kind, src) {
    return newPreset(kind, {
      name: src.name || '副 API',
      baseUrl: src.baseUrl || '',
      apiKey: src.apiKey || '',
      model: src.model || '',
      seededFrom: src.name || '副 API'
    });
  }

  /* 新增副 API 时自动带一份：只在**这边还是空的**时候填（填过就不再覆盖，
     用户改过的东西不能丢）。
     ⚠️ 只有**总结**会走到这儿 —— 向量要的是 embedding 模型，带过来是错的。 */
  function seedFromSub(kind) {
    if (!hasPresets(kind)) return false;
    if (cfgOf(kind)) return false;
    var src = subSource();
    if (!src) return false;
    var item = presetFromSub(kind, src);
    savePresetsOf(kind, [item]);          /* 覆盖：镜像是空的时候列表里的残留是孤儿 */
    setActive(kind, item.id);
    return true;
  }

  /* 新增副 API 之后调一次：把空着的**总结**顺手填上。
     ⚠️ 向量不在内 —— 副 API 是对话模型，向量要 embedding，协议都不一样
     （用户 2026-09-23 明确：「向量记忆 api 不要复制…只有总结的才需要复制和列表」）。
     导出给 page-subapi.js 用（那边只管喊一声，不关心填了什么）。 */
  function seedAll() {
    return seedFromSub('summary') ? 1 : 0;
  }

  /* 列表页的「从副 API 复制一份」：**无条件**新增一份并切过去
     （用户点了就是要复制，不是「只在空的时候」）。 */
  function copyFromSub(kind) {
    if (!hasPresets(kind)) return null;   /* 单份（向量）不参与复制 */
    var src = subSource();
    if (!src) return null;
    var item = presetFromSub(kind, src);
    var list = presetsOf(kind);
    list.push(item);
    savePresetsOf(kind, list);
    setActive(kind, item.id);             /* 复制过来就切到它 */
    return item;
  }

  /* ---------------------------- 测试 ---------------------------- */

  function runTest(kind, cfg) {
    if (kind === 'vector' || !KINDS[kind].testChat) {
      return Sleepy.api.embed(cfg, ['测试']).then(function (res) {
        return res.ok ? { ok: true, text: '通了 · 返回 ' + res.dim + ' 维向量' }
          : { ok: false, text: Sleepy.api.describeError(res) };
      });
    }
    return Sleepy.api.requestOnce({ cfg: cfg }, [{ role: 'user', content: '说一句「好」就行' }], { maxTokens: 8 })
      .then(function (res) {
        return res.ok ? { ok: true, text: '通了 · 回了「' + String(res.content || '').trim().slice(0, 20) + '」' }
          : { ok: false, text: Sleepy.api.describeError(res) };
      });
  }

  function testConn(kind, ctx) {
    var cfg = cfgOf(kind);
    if (!cfg) { ctx.toast('先把地址和模型填上', 'warn'); return; }
    ctx.toast('正在测……');
    return runTest(kind, cfg).then(function (r) {
      ctx.toast(r.text, r.ok ? 'ok' : 'err');
      return r;
    });
  }

  /* ---------------------------- 页面：预设列表 ---------------------------- */

  function renderList(ctx, kind) {
    var k = KINDS[kind];
    var body = ctx.body;
    body.innerHTML = '';
    ctx.setTitle(k.title);
    ctx.setActions([]);

    var g = group(k.title + '预设',
      '可以存好几套，随时切换当前使用的那套。');
    var listCard = g.card;

    function subCopyHint() {
      var src = subSource();
      return src ? (src.name || '第一组') + ' · ' + src.baseUrl : '还没有可用的副 API';
    }

    function refresh() {
      listCard.innerHTML = '';
      var list = presetsOf(kind);
      var act = activeIdOf(kind);

      if (!list.length) {
        listCard.appendChild(row({ label: '还没有预设', plain: true }));
      } else {
        list.forEach(function (p) {
          var isCur = p.id === act;
          listCard.appendChild(row({
            label: p.name || k.defaultName,
            hint: p.model || '还没填模型名',
            badge: isCur ? '当前使用' : '备用',
            badgeKind: isCur ? 'ok' : 'dim',
            onClick: function () { ctx.open('settings-' + kind + '-edit', { id: p.id }); }
          }));
        });
      }

      listCard.appendChild(row({
        label: '添加新预设',
        onClick: function () { ctx.open('settings-' + kind + '-add'); }
      }));
      listCard.appendChild(row({
        label: '从副 API 复制一份',
        hint: subCopyHint(),
        onClick: function () {
          var item = copyFromSub(kind);
          if (!item) { ctx.toast('先把副 API 的地址填上', 'warn'); return; }
          ctx.toast('已复制一份，并设为当前使用', 'ok');
          refresh();
        }
      }));
    }

    refresh();
    body.appendChild(g.wrap);

    /* 这个接口干什么 —— 放在列表下面当说明，不占列表的位置 */
    var gHint = group('这个接口干什么', k.hint);
    body.appendChild(gHint.wrap);

    var foot = h('p', 'set-foot', '所有 Key 只存在这台设备的浏览器里，不经过我的服务器。');
    body.appendChild(foot);

    ctx.rebuild = refresh;
  }

  /* --------- 页面：向量记忆 API（单份，一页表单，没有预设这一层） ---------
     它**不从副 API 复制**：副 API 是对话模型，向量要 embedding，协议都不一样
     （/chat/completions vs /embeddings），复制过来只会得到一份注定 404 的配置
     （用户 2026-09-23 明确）。所以它一页到底：说明 + 连接表单（带拉取）+
     用不用 / 索引 / 试试召回 + 清空。 */
  function renderSingle(ctx, kind) {
    var k = KINDS[kind];
    var body = ctx.body;
    var cur = store.get(k.key) || {};
    var f = {};

    body.innerHTML = '';
    ctx.setTitle(k.title);
    ctx.setActions([]);
    ctx.__paint = function () { renderSingle(ctx, kind); };

    var gHint = group('这个接口干什么', k.hint);
    body.appendChild(gHint.wrap);

    var g = group('连接');
    f.baseUrl = textField({
      label: '接口地址 Base URL',
      hint: '填到 /v1 就行，测试时会自动补 /embeddings',
      value: cur.baseUrl || '',
      placeholder: 'https://api.example.com/v1',
      inputmode: 'url'
    });
    g.card.appendChild(f.baseUrl.el);

    f.apiKey = textField({
      label: 'API Key',
      hint: '明文存在本机浏览器，换设备不会跟着走',
      value: cur.apiKey || '',
      placeholder: 'sk-...',
      password: true
    });
    g.card.appendChild(f.apiKey.el);

    f.model = textField({
      label: '模型名',
      hint: k.modelHint,
      value: cur.model || '',
      placeholder: k.placeholder
    });
    g.card.appendChild(f.model.el);
    /* 拉取模型：和主 API / 总结 API 一样的那枚小圆钮 */
    f.model.el.querySelector('.set-line').appendChild(ui.modelPickButton({
      load: function () {
        return Sleepy.api.fetchModels({ baseUrl: f.baseUrl.get(), apiKey: f.apiKey.get() });
      },
      onPick: function (id) { f.model.input.value = id; }
    }));

    var acts = h('div', 'dl-actions');
    acts.appendChild(button('保存', 'dl-btn is-primary', function () { doSave(); }));
    acts.appendChild(button('测试连接', 'dl-btn', function () { doTest(); }));
    g.card.appendChild(acts);
    body.appendChild(g.wrap);

    renderVectorTools(ctx, body);

    var g2 = group('恢复默认', k.fallback);
    g2.card.appendChild(button('清空这份配置', 'dl-btn is-danger', function () {
      if (!cfgOf(kind)) { ctx.toast('本来就是空的'); return; }
      clearCfg(kind);
      ctx.toast('清掉了');
      renderSingle(ctx, kind);
    }));
    body.appendChild(g2.wrap);

    var foot = h('p', 'set-foot', '所有 Key 只存在这台设备的浏览器里，不经过我的服务器。');
    body.appendChild(foot);

    function doSave() {
      var u = String(f.baseUrl.get() || '').trim();
      var m = String(f.model.get() || '').trim();
      if (!u || !m) { ctx.toast('地址和模型名都要填', 'warn'); return; }
      saveCfg(kind, {
        baseUrl: u,
        apiKey: String(f.apiKey.get() || '').trim(),
        model: m,
        seededFrom: ''          /* 用户自己动过，就不再是「带过来的」了 */
      });
      ctx.toast('存好了');
      renderSingle(ctx, kind);
    }

    function doTest() {
      var cfg = {
        baseUrl: String(f.baseUrl.get() || '').trim(),
        apiKey: String(f.apiKey.get() || '').trim(),
        model: String(f.model.get() || '').trim()
      };
      if (!cfg.baseUrl || !cfg.model) { ctx.toast('先把地址和模型填上', 'warn'); return; }
      ctx.toast('正在测……');
      runTest(kind, cfg).then(function (r) {
        ctx.toast(r.text, r.ok ? 'ok' : 'err');
      });
    }
  }

  /* ------------------- 向量页独有：总开关 / 索引 / 试试召回 ------------------- */

  function renderVectorTools(ctx, body) {
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
          /* 0 条不在这儿说 —— 下面「索引」组的空态已经有一句一模一样的了 */
          statLine.textContent = n
            ? ('已经索引了 ' + n + ' 段对话。聊得越多，能找回来的越多。')
            : '';
        });
      })['catch'](function () { statLine.textContent = ''; });
    } else {
      statLine.textContent = '';
    }

    /* ---- 索引里到底有什么 ----
       三件事都在这两块：**看得见**（每个角色/每个群各有多少段）、
       **能清**（删掉某一份，不碰聊天记录）、**能自己试**
       （「这句话会捞回哪些旧片段」）。最后那个是故意留的 ——
       「召回得准不准」没法写成断言，只能让人眼看一眼。 */
    var gIdx = group('索引',
      '每一条都是真实聊过的一小段。清理不影响聊天记录。');
    var staleWrap = h('div', 'vec-stale-wrap');
    gIdx.card.appendChild(staleWrap);

    /* ---- 项目 5：DB 升级后的「重建记忆索引」提示（口径 A，2026-09-26）----
       升级把旧块清了，历史内容不会自动回索引。提示挂在这，用户点了才开始
       全量扫（不静默花钱）：成功清提示；失败留着原因和重试入口（不假装完成）；
       重建中防重复点击、显示进度；没点之前新消息照常增量建块。 */
    var rebuildWrap = h('div', 'vec-stale-wrap');
    gIdx.card.appendChild(rebuildWrap);

    function renderRebuild() {
      rebuildWrap.innerHTML = '';
      var MV = Sleepy.memoryVec;
      if (!MV || !MV.rebuildState) return;
      var st = MV.rebuildState();
      if (!st) return;                       /* 没有提示（已重建完 / 全新装机） */
      var row = h('div', 'vec-row vec-stale');
      var main = h('div', 'vec-row-main');
      var btnLabel = '重建记忆索引';
      var note = '';
      var running = false;
      if (st.state === 'running') {
        running = true;
        main.appendChild(h('div', 'vec-row-name', '正在重建记忆索引…'));
        note = '已扫 ' + (st.rounds || 0) + ' 轮，新增 ' + (st.added || 0) +
          ' 段 —— 期间可以正常用，新消息不受影响。';
        btnLabel = '重建中…';
      } else if (st.state === 'failed') {
        main.appendChild(h('div', 'vec-row-name', '上次重建没有完成'));
        note = '原因：' + (st.error || st.why || '未知') +
          ' —— 已经扫好的部分不会重复算，点下面的按钮接着扫。';
      } else {
        main.appendChild(h('div', 'vec-row-name', '记忆索引需要重建'));
        note = '数据库升级后旧的索引已清空（聊天记录没动）。点「重建」会把历史内容' +
          '重新扫进索引 —— 要一条条算向量，时间和费用取决于内容量。' +
          '重建之前，新消息照常进索引，旧内容暂时想不起来。';
      }
      var noteEl = h('div', 'vec-row-meta', note);
      main.appendChild(noteEl);
      row.appendChild(main);
      var btn = button(btnLabel, 'dl-btn is-primary', function () {
        if (running || busyRebuild) return;
        busyRebuild = true;
        btn.disabled = true;
        noteEl.textContent = '正在重建…（要一条条算向量，内容多会久一点）';
        MV.rebuildIndex({
          onProgress: function (p) {
            noteEl.textContent = '正在重建…已扫 ' + p.rounds + ' 轮，新增 ' + p.added + ' 段';
          }
        }).then(function (r) {
          busyRebuild = false;
          if (r && r.ok) ctx.toast('重建完成：新增 ' + r.added + ' 段', 'ok');
          else if (r && r.why === 'running') ctx.toast('已经在重建了', 'warn');
          else ctx.toast('重建没有完成：' + ((r && (r.error || r.why)) || '未知原因'), 'warn');
          renderRebuild();
          renderList2();
        }, function (e) {
          busyRebuild = false;
          ctx.toast('重建出错了：' + ((e && e.message) || e), 'warn');
          renderRebuild();
          renderList2();
        });
      });
      if (running || busyRebuild) btn.disabled = true;
      row.appendChild(btn);
      rebuildWrap.appendChild(row);
    }
    var busyRebuild = false;
    renderRebuild();

    /* ---- 「现在扫一遍」----
       为什么要有这个按钮：索引是聊天时**后台悄悄建**的，失败也不吭声 ——
       用户看到的是「聊了半天一条都没有」，然后不知道该怪接口还是怪我。
       这个按钮把过程摊开：清了退避、扫了本岛哪几场、新增几块、谁失败、失败原因。
       （它同时是「重开记忆开关之后的补扫」和「换 embedding 模型之后重建」的入口。） */
    var sweepNote = h('p', 'set-group-note', '');
    /* 上一次「现在扫一遍」的结果。空索引时那句文案要跟它对得上 ——
       刚扫失败、列表还是空的，却写「聊几轮之后会自动开始」，
       用户会以为一切正常（2026-09-23 用户截图里就是这两句并排出现）。 */
    var lastSweep = null;
    var sweepBtn = button('现在扫一遍（把本岛的聊天补进索引）', 'dl-btn is-primary', function () {
      if (!Sleepy.memoryVec || !Sleepy.memoryVec.sweepIsland) return;
      sweepBtn.disabled = true;
      sweepNote.textContent = '正在扫…（要一条条算向量，聊得多会慢一点）';
      Sleepy.memoryVec.sweepIsland().then(function (r) {
        sweepBtn.disabled = false;
        lastSweep = r;
        sweepNote.textContent = sweepReport(r);
        renderList2();                 /* 扫完刷新下面那份列表，看得见新增 */
      }, function (e) {
        sweepBtn.disabled = false;
        lastSweep = { ok: false, why: 'error', error: (e && e.message) || String(e) };
        sweepNote.textContent = '扫的时候出错了：' + ((e && e.message) || e);
      });
    });
    var sweepActs = h('div', 'dl-actions');
    sweepActs.appendChild(sweepBtn);
    gIdx.card.appendChild(sweepActs);
    gIdx.card.appendChild(sweepNote);

    var listWrap = h('div', 'vec-list');
    listWrap.appendChild(h('p', 'set-group-note', '正在读索引…'));
    gIdx.card.appendChild(listWrap);

    /* 把 sweepIsland 的结果翻译成人话 —— 每一种「没成」都要说得出下一步该干什么 */
    function sweepReport(r) {
      if (!r) return '没有结果。';
      if (r.why === 'off') return '向量接口还没配好（或者总开关关着）—— 先把上面那几项填好，再点一次。';
      if (r.why === 'noidb') return '这台设备用不了 IndexedDB，索引存不下来。';
      if (r.why === 'noisland') return '现在还没落岛（没有"当前岛"）—— 先去浮岛选一座岛。';
      if (r.why === 'nochat') return '本岛还没有聊过天的角色。';
      if (r.why === 'error') return '扫的时候出错了：' + (r.error || '未知原因');
      if (r.why === 'nothing') {
        return '本岛 ' + r.chats + ' 场聊天都已经在索引里了（跑了 ' + r.rounds + ' 轮，没有新内容）。';
      }
      var head = r.ok
        ? '扫完：' + r.chats + ' 场聊天，新增 ' + r.added + ' 段（' + r.rounds + ' 轮）。'
        : '部分失败：' + r.chats + ' 场里 ' + r.failed.length + ' 场没扫成，新增 ' + r.added + ' 段。';
      if (r.failed.length) {
        var f = r.failed.slice(0, 2).map(function (x) {
          var why = x.why === 'backoff' ? '接口连不上（正在退避）'
            : x.why === 'embed' ? '算向量失败'
            : x.why === 'off' ? '接口没配'
            : x.why === 'noidb' ? '存不进索引'
            : x.why;
          return (x.name || x.chatId) + '：' + why + (x.error ? '（' + String(x.error).slice(0, 60) + '）' : '');
        }).join('；');
        head += ' ' + f + (r.failed.length > 2 ? ' 等' : '');
      }
      return head;
    }

    var gTry = group('试试召回',
      '写一句现在可能说的话，看它会捞回哪些旧片段。');
    var pick = h('select', 'vec-pick');
    var qEl = ui.textArea({
      label: '如果现在说…', value: '', rows: 3,
      placeholder: '比如：上次说的那家店'
    });
    var tryBtn = button('找找看', 'dl-btn is-primary', function () { runProbe(); });
    var tryActs = h('div', 'dl-actions');
    tryActs.appendChild(tryBtn);
    var outWrap = h('div', 'vec-out');
    gTry.card.appendChild(pick);
    gTry.card.appendChild(qEl.el);
    gTry.card.appendChild(tryActs);
    gTry.card.appendChild(outWrap);

    var targets = [];       /* 概览的每一行，给「试试召回」当选项 */

    /* 名字不给向量层解析（它不认识 core 和群）—— 在这里补上。
       找不到多半是「这个角色不在这座岛上」，如实说，别显示成空白。 */
    function ownerName(r) {
      if (r.groupId) {
        var g = Sleepy.groupStore && Sleepy.groupStore.findGroup(r.groupId);
        return (g && g.name) || '一个不在当前岛的群';
      }
      if (!r.charId) {
        /* 岛级 / 账号级池（2026-09-23 向量补源）：没有角色可问，按池说。
           `island:<id>` / `user:<id>` 是 memory-vec 的池主键（见那边的注释）。 */
        var pool = String(r.ownerKey || '').split(':')[0];
        if (pool === 'island') return '这座岛上的朋友圈';
        if (pool === 'user') return '我写的日记';
        return '一段素材';
      }
      var c = Sleepy.core && Sleepy.core.findChar(r.charId);
      return (c && c.name) || '一位不在当前岛的角色';
    }

    /* 池的中文名（概览按 kind 分组显示用） */
    var VEC_KIND_CN = {
      chat: '对话', offline: '线下', group: '群聊',
      moment: '动态', diary: '日记', mem: '档案', phone: '手机'
    };

    function dayText(ts) {
      if (!ts) return '—';
      var d = new Date(ts);
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    function forgetOf(r) {
      /* 岛级 / 账号级池没有 charId / groupId 可推 —— 直接用 ownerKey。
         （只认 charId 的话那两行的「清掉」会变成清 0 条，静默失败。） */
      if (r.ownerKey) return { ownerKey: r.ownerKey };
      return r.groupId ? { groupId: r.groupId } : { charId: r.charId };
    }

    function fillPick() {
      pick.innerHTML = '';
      if (!targets.length) {
        var o0 = h('option', '', '（还没有索引）');
        o0.value = '';
        pick.appendChild(o0);
        return;
      }
      targets.forEach(function (t, i) {
        var o = h('option', '', t.name + ' · ' + t.row.blocks + ' 段');
        o.value = String(i);
        pick.appendChild(o);
      });
    }

    /* 换过 embedding 模型的话，库里会留下一批「别的模型」做的块 ——
       它们不参与召回（见 memoryVec.sameModel），但占地方，提示一下能清掉。 */
    function renderStale() {
      staleWrap.innerHTML = '';
      if (!Sleepy.memoryVec || !Sleepy.memoryVec.stale) return;
      Sleepy.memoryVec.stale().then(function (n) {
        if (!n) return;
        var warn = h('div', 'vec-row vec-stale');
        var wm = h('div', 'vec-row-main');
        wm.appendChild(h('div', 'vec-row-name', '有 ' + n + ' 段是别的向量模型做的'));
        wm.appendChild(h('div', 'vec-row-meta',
          '换了模型之后它们对不上号，已经不参与召回了 —— 建议清掉（聊天记录不动）'));
        warn.appendChild(wm);
        warn.appendChild(button('清掉', 'dl-btn is-danger', function () {
          ui.confirm({
            title: '清掉这 ' + n + ' 段旧模型的索引？',
            note: '聊天记录一个字都不会动。之后按原来的节奏重新索引。',
            ok: '清掉', danger: true
          }).then(function (yes) {
            if (!yes) return;
            Sleepy.memoryVec.forgetStale().then(function (m) {
              ctx.toast('清掉了 ' + m + ' 段', 'ok');
              renderList2();
            });
          });
        }));
        staleWrap.appendChild(warn);
      })['catch'](function () { /* 提示失败就算了，别挡列表 */ });
    }

    function renderList2() {
      renderStale();
      renderRebuild();     /* 扫描/重建有结果后，重建提示的状态要跟着刷新 */
      listWrap.innerHTML = '';
      if (!Sleepy.memoryVec || !Sleepy.memoryVec.overview) {
        listWrap.appendChild(h('p', 'set-group-note', '向量模块没加载。'));
        return;
      }
      Sleepy.memoryVec.overview().then(function (list) {
        listWrap.innerHTML = '';
        targets = [];
        if (!list.length) {
          /* 扫失败之后这一句必须换掉：空索引 + 「会自动开始」＝ 用户以为没事 */
          listWrap.appendChild(h('p', 'set-group-note', (lastSweep && !lastSweep.ok)
            ? '还没扫成 —— 上面那条写着原因，改好之后再点一次「现在扫一遍」。'
            : '还没有索引 —— 聊几轮之后会自动开始（在后台跑，不挡聊天）。'));
          fillPick();
          return;
        }
        list.forEach(function (r) {
          var name = ownerName(r);
          targets.push({ row: r, name: name });
          var line = h('div', 'vec-row');
          var main = h('div', 'vec-row-main');
          main.appendChild(h('div', 'vec-row-name', name));
          /* 当前数 / 上限（**分池**）+ 最近 / 最早时间 —— 分池淘汰之后
             「一共多少段」不再等于「快满了」（见 memory-vec 的 poolMax）。 */
          var bits = [];
          if (r.chatCount) bits.push('对话 ' + r.chatCount + '/' + r.chatMax);
          if (r.memoCount) bits.push('素材 ' + r.memoCount + '/' + r.memoMax);
          main.appendChild(h('div', 'vec-row-meta',
            r.blocks + ' 段' + (bits.length ? '（' + bits.join(' · ') + '）' : '') +
            ' · 最近 ' + dayText(r.newestAt) +
            (r.oldestAt ? ' · 最早 ' + dayText(r.oldestAt) : '')));
          var kd = r.kinds || {};
          var detail = Object.keys(kd).map(function (x) {
            return (VEC_KIND_CN[x] || x) + ' ' + kd[x];
          }).join(' · ');
          if (detail) main.appendChild(h('div', 'vec-row-meta', detail));
          line.appendChild(main);
          line.appendChild(button('清掉', 'dl-btn is-danger', function () {
            ui.confirm({
              title: '清掉「' + name + '」的索引？',
              note: '聊天记录一个字都不会动 —— 只是以后按话题想不起这些片段了。',
              ok: '清掉', danger: true
            }).then(function (yes) {
              if (!yes) return;
              Sleepy.memoryVec.forget(forgetOf(r)).then(function (n) {
                ctx.toast('清掉了 ' + n + ' 段', 'ok');
                renderList2();
              });
            });
          }));
          listWrap.appendChild(line);
        });
        fillPick();
      })['catch'](function () {
        listWrap.innerHTML = '';
        listWrap.appendChild(h('p', 'set-group-note', '索引读不出来。'));
      });
    }

    function whyNoProbe(r) {
      if (r.why === 'off') return '先在上面把接口配上、开关打开。';
      if (r.why === 'empty') return '先写一句话。';
      if (r.why === 'noidb') return '这台设备用不了 IndexedDB。';
      if (r.why === 'embed') return '接口没通：' + (r.error || '看看地址和 Key');
      return '读不出来：' + (r.error || r.why || '');
    }

    function runProbe() {
      outWrap.innerHTML = '';
      var t = targets[parseInt(pick.value, 10)];
      if (!t) { outWrap.appendChild(h('p', 'set-group-note', '先有索引才能试。')); return; }
      var q = String(qEl.get() || '').trim();
      if (!q) { ctx.toast('先写一句话', 'warn'); return; }
      outWrap.appendChild(h('p', 'set-group-note', '正在算…'));
      /* 私聊的索引是按身份隔离的（见 memoryVec.visibleTo）——
         试的时候要用**当前这个身份**，否则有认知屏障时什么都捞不到。 */
      var uid = (Sleepy.core && Sleepy.core.activeUserOnIsland
        && (Sleepy.core.activeUserOnIsland() || {}).id) || null;
      /* 岛级 / 账号级池（朋友圈 / 我写的日记）自己没有「谁在看」——
         试召回得指定一个人，用当前岛上的活跃角色
         （池里的东西最终是给某个角色召回的）。 */
      var cid = t.row.charId;
      if (!cid && !t.row.groupId && Sleepy.core && Sleepy.core.activeCharOnIsland) {
        cid = ((Sleepy.core.activeCharOnIsland() || {}).id) || null;
      }
      if (!t.row.groupId && !cid) {
        outWrap.appendChild(h('p', 'set-group-note',
          '这条索引不属于某个具体角色 —— 先降落在一座岛上再试。'));
        return;
      }
      var f = t.row.groupId ? { groupId: t.row.groupId }
        : { charId: cid, userId: uid };
      Sleepy.memoryVec.probe(f, q).then(function (r) {
        outWrap.innerHTML = '';
        if (!r.ok) { outWrap.appendChild(h('p', 'set-group-note', whyNoProbe(r))); return; }
        if (!r.items.length) {
          outWrap.appendChild(h('p', 'set-group-note',
            '没找到相关的（索引里有 ' + r.blocks + ' 段）。'));
          return;
        }
        outWrap.appendChild(h('p', 'set-group-note',
          '共 ' + r.blocks + ' 段，最像的 ' + r.items.length + ' 段：'));
        r.items.forEach(function (it) {
          var card = h('div', 'vec-hit');
          card.appendChild(h('div', 'vec-hit-head',
            '像 ' + Math.round((it.sim || 0) * 100) + '%  ·  ' + dayText(it.at)));
          card.appendChild(h('p', 'vec-hit-text', String(it.text || '')));
          outWrap.appendChild(card);
        });
      })['catch'](function (e) {
        outWrap.innerHTML = '';
        outWrap.appendChild(h('p', 'set-group-note', '出错：' + ((e && e.message) || e)));
      });
    }

    renderList2();

    body.appendChild(gV.wrap);
    body.appendChild(gIdx.wrap);
    body.appendChild(gTry.wrap);
  }

  /* ---------------------------- 页面：预设表单 ---------------------------- */

  function renderForm(ctx, kind, preset, isNew) {
    var k = KINDS[kind];
    var body = ctx.body;
    var f = {};

    var g = group('接口');
    f.name = textField({ label: '备注名', value: preset.name, placeholder: k.defaultName });
    g.card.appendChild(f.name.el);

    f.baseUrl = textField({
      label: '接口地址 Base URL',
      hint: kind === 'vector'
        ? '填到 /v1 就行，测试时会自动补 /embeddings'
        : '填到 /v1 就行，测试时会自动补 /chat/completions',
      value: preset.baseUrl,
      placeholder: 'https://api.example.com/v1',
      inputmode: 'url'
    });
    g.card.appendChild(f.baseUrl.el);

    f.apiKey = textField({
      label: 'API Key',
      hint: '明文存在本机浏览器，换设备不会跟着走',
      value: preset.apiKey,
      placeholder: 'sk-...',
      password: true
    });
    g.card.appendChild(f.apiKey.el);

    f.model = textField({
      label: '模型名',
      hint: k.modelHint,
      value: preset.model,
      placeholder: k.placeholder
    });
    g.card.appendChild(f.model.el);

    /* 拉取模型：模型名旁边的小圆钮，用表单里当前的地址和 Key，不用先保存。
       结果是**浮层**（ui.modelPickButton → ui.modelPicker），不是铺在页面里 ——
       拉一次可能回 60 个模型名，铺在页面里整页会被拉得很长。 */
    var mini = ui.modelPickButton({
      load: function () {
        return Sleepy.api.fetchModels({ baseUrl: f.baseUrl.get(), apiKey: f.apiKey.get() });
      },
      onPick: function (id) { f.model.input.value = id; }
    });
    f.model.el.querySelector('.set-line').appendChild(mini);

    body.appendChild(g.wrap);

    var g2 = group('用哪套');
    f.isCurrent = null;
    if (!isNew) {
      f.isCurrent = switchField({
        label: '当前使用这套',
        hint: '关掉会自动把「当前」让给列表里的第一套别的',
        value: preset.id === activeIdOf(kind)
      });
      g2.card.appendChild(f.isCurrent.el);
    } else {
      g2.card.appendChild(h('p', 'set-group-note', '存完自动成为当前使用的那套。'));
    }
    body.appendChild(g2.wrap);

    /* 测试区 */
    var g4 = group('测试连接');
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
        name: f.name.get() || k.defaultName,
        baseUrl: String(f.baseUrl.get() || '').trim(),
        apiKey: String(f.apiKey.get() || '').trim(),
        model: String(f.model.get() || '').trim(),
        seededFrom: ''          /* 用户自己动过，就不再是「带过来的」了 */
      };
    }

    function doSave() {
      var next = collect();
      if (!next.baseUrl || !next.model) { ctx.toast('地址和模型名都要填', 'warn'); return; }

      var list = presetsOf(kind);
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === next.id) { idx = i; break; }
      if (idx >= 0) list[idx] = next; else list.push(next);

      /* 「当前使用」落定：开了开关就用这套；关掉且原来是当前 → 让给第一套别的 */
      var act = activeIdOf(kind);
      var wantCurrent = isNew ? true : !!(f.isCurrent && f.isCurrent.get());
      var targetId = next.id;
      if (!wantCurrent && next.id === act) {
        targetId = '';
        for (var j = 0; j < list.length; j++) {
          if (list[j].id !== next.id) { targetId = list[j].id; break; }
        }
      }

      var ok = savePresetsOf(kind, list);
      setActive(kind, targetId);   /* 镜像跟着当前那套走 */

      if (ok) {
        ctx.toast(wantCurrent ? '已保存并设为当前' : '已保存', 'ok');
        ctx.back();
      } else {
        ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
      }
    }

    function doDelete() {
      var list = presetsOf(kind).filter(function (x) { return x.id !== preset.id; });
      var wasActive = preset.id === activeIdOf(kind);
      var ok = savePresetsOf(kind, list);
      if (wasActive) setActive(kind, list.length ? list[0].id : '');
      if (ok) {
        ctx.toast('已删除', 'ok');
        ctx.back();
      } else {
        ctx.toast('删除失败', 'err');
      }
    }

    function doTest() {
      var next = collect();
      if (!next.baseUrl || !next.model) { ctx.toast('先把地址和模型填上', 'warn'); return; }
      testBtn.disabled = true;
      saveBtn.disabled = true;
      if (delBtn) delBtn.disabled = true;
      ctx.toast('正在测……');
      runTest(kind, next).then(function (r) {
        ctx.toast(r.text, r.ok ? 'ok' : 'err');
        testBtn.disabled = false;
        saveBtn.disabled = false;
        if (delBtn) delBtn.disabled = false;
      });
    }
  }

  /* ---------------------------- 注册 ---------------------------- */

  Sleepy.register('settings-summary', {
    title: '总结 API',
    render: function (ctx) { renderList(ctx, 'summary'); },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  Sleepy.register('settings-summary-add', {
    title: '新增总结 API',
    render: function (ctx) {
      renderForm(ctx, 'summary', newPreset('summary', { name: '' }), true);
    }
  });

  Sleepy.register('settings-summary-edit', {
    title: '编辑总结 API',
    render: function (ctx) {
      var p = null;
      presetsOf('summary').forEach(function (x) { if (x.id === ctx.params.id) p = x; });
      if (!p) { ctx.toast('找不到这套预设', 'err'); ctx.back(); return; }
      renderForm(ctx, 'summary', p, false);
    }
  });

  /* 向量是一页表单（没有预设、也不从副 API 复制），走 renderSingle */
  Sleepy.register('settings-vector', {
    title: '向量记忆 API',
    render: function (ctx) { renderSingle(ctx, 'vector'); },
    onShow: function (ctx) { if (ctx.__paint) ctx.__paint(); }
  });

  /* 给 page-subapi.js 用：新增副 API 后顺手把空的那两份填上 */
  Sleepy.singleApi = {
    KINDS: KINDS,
    cfgOf: cfgOf,
    saveCfg: saveCfg,
    clearCfg: clearCfg,
    presetsOf: presetsOf,
    activePreset: activePreset,
    setActive: setActive,
    seedFromSub: seedFromSub,
    seedAll: seedAll,
    copyFromSub: copyFromSub,
    testConn: testConn
  };

})(window);
