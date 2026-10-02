/* ============================================================
   page-imggen.js — 生图设置（挂在设置 App 里，不开独立桌面 App）
   依赖：store.js、ui.js、app.js、media.js、imggen.js（必须在它之前加载）

   用户拍板：不占桌面格子（桌面已经 12 个了），从 设置 → 生图 进来。
   这一页从上到下：开关 / 接口 / 试一张（默认收起）/ 提示词库。

   精致原则（用户：「能简化成小的按钮会更舒适」）：
   - 拉取模型是大按钮改成模型名旁边的小图标钮；
   - 「试一张」默认收起，点一下才展开，框也小一号；
   - 提示词库的类别用下拉列表选，不是让人手打。

   报错必须可复制、带原始返回 —— 用户要拿去反馈给中转站，
   且里面不能有我们自己的链接（用户明确要求）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var imggen = Sleepy.imggen;
  var media = Sleepy.media;
  var core = Sleepy.core;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var setRowBadge = ui.setRowBadge;
  var textField = ui.textField;
  var numField = ui.numField;
  var textArea = ui.textArea;
  var switchField = ui.switchField;
  var button = ui.button;

  /* 那枚「拉取模型」小圆钮现在统一由 ui.modelPickButton 提供
     （含图标 + 接浮层）—— 这里原来有一份 MINI_ICONS + miniIconBtn，
     收敛到 ui 之后就没人用了，删掉免得日后有人照着它再抄一份。 */

  /* 可收起的一组（点头部行展开/收起）。精致原则：默认收起。 */
  function foldGroup(title, hint, defaultOpen) {
    var g = group('');
    g.wrap.classList.add('imggen-fold');
    var head = h('button', 'set-row imggen-fold-head');
    head.type = 'button';
    head.innerHTML = '<span class="set-row-label">' + title
      + '</span><span class="imggen-fold-arrow"><svg viewBox="0 0 20 20" width="14" '
      + 'height="14" fill="none" stroke="currentColor" stroke-width="1.6" '
      + 'stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M6 8l4 4 4-4"/></svg></span>';
    var bodyBox = h('div', 'imggen-fold-body');
    if (hint) bodyBox.appendChild(h('p', 'set-hint', hint));
    g.card.appendChild(head);
    g.card.appendChild(bodyBox);
    function setOpen(on) {
      g.wrap.classList.toggle('is-open', on);
    }
    head.addEventListener('click', function () {
      setOpen(!g.wrap.classList.contains('is-open'));
    });
    setOpen(!!defaultOpen);
    return { wrap: g.wrap, body: bodyBox };
  }

  /* ------------------------- 设置一级页的摘要 ------------------------- */

  function summary() {
    if (!imggen.readEnabled()) return '已关闭';
    var list = imggen.listApis();
    var on = 0;
    for (var i = 0; i < list.length; i++) if (list[i].enabled !== false) on++;
    if (!list.length) return '未配置';
    var act = imggen.activeApi();
    return act ? ('当前 ' + (act.name || '未命名')) : ('已启用 ' + on + ' / ' + list.length);
  }

  /* 设置一级页那一行的摘要也用它（page-settings.js 引 Sleepy.imggenSummary） */
  Sleepy.imggenSummary = summary;

  /* ==================== 页面：生图（总览） ==================== */

  Sleepy.register('settings-imggen', {
    title: '生图',
    render: function (ctx) {
      var body = ctx.body;

      /* ---------- 开关 ---------- */
      var g0 = group('开关', '关掉之后聊天里的生图入口全部隐藏，配置原样保留。');
      var swEnabled = switchField({
        label: '启用生图',
        hint: '个人开关（每个会话各管各的）以后放在聊天设置页',
        value: imggen.readEnabled()
      });
      swEnabled.input.addEventListener('change', function () {
        imggen.setEnabled(swEnabled.get());
      });
      g0.card.appendChild(swEnabled.el);
      body.appendChild(g0.wrap);

      /* ---------- 正式生图视觉层（内置 / 自定义，2026-10-01 施工单 v1 §四） ----------
         只有两档；内置词暂不提供编辑（§一）。切换不清空自定义原文；
         自定义框只在 custom 档露面。独立字段，与实验区的 visualExp* 互不混用。 */
      var gs = group('视觉层（正式生图）',
        '聊天发图、日记、朋友圈这些正式入口用哪套审美：内置＝已核准底座；自定义＝只替换审美层，人数、身份、镜头与画面事实照常保留。');
      var styleWrap = h('div', 'set-field');
      styleWrap.appendChild(h('label', 'set-label', '视觉层'));
      var styleSel = h('select', 'set-select');
      [['builtin', '内置（已核准底座）'], ['custom', '自定义视觉词']].forEach(function (p) {
        var opt = h('option', '', p[1]);
        opt.value = p[0];
        if (imggen.imgStyleMode() === p[0]) opt.selected = true;
        styleSel.appendChild(opt);
      });
      styleWrap.appendChild(styleSel);
      gs.card.appendChild(styleWrap);

      var styleCustom = textArea({
        label: '自定义视觉词',
        hint: '只替换审美层；留空也合法 —— 保留结构与必要质量层，不会回退成内置词。',
        rows: 3,
        value: imggen.imgStyleCustom(),
        placeholder: '例：flat graphic illustration, limited 6-color palette'
      });
      gs.card.appendChild(styleCustom.el);
      var styleHint = h('p', 'set-hint', '');
      gs.card.appendChild(styleHint);
      /* 返修单 v2 P1：NAI 不接本轮视觉层要在 UI 如实说（custom 也不生效）；
         正式设置与实验设置分开讲清楚，旧实验文本不迁移、不清空。 */
      gs.card.appendChild(h('p', 'set-hint',
        'NAI 接口沿用其原生图路径，本组的内置／自定义视觉层（含自定义原文）都不生效。'
        + '这组只管「正式生图」入口；「试一张」实验区有自己独立的视觉设置，'
        + '两边互不影响，各自的原文都原样保留。'));
      function syncStyleUI() {
        var isCustom = styleSel.value === 'custom';
        styleCustom.el.style.display = isCustom ? '' : 'none';
        styleHint.textContent = isCustom
          ? (imggen.imgStyleCustom().trim()
            ? '自定义原文会整份进请求（恰好一份，不与内置词混拼）。'
            : '未添加自定义视觉词：这张就没有额外审美词，不回退内置。')
          : '内置词暂不提供编辑；切到「自定义」时这里写的原文原样保留。';
      }
      styleSel.addEventListener('change', function () {
        imggen.setImgStyleMode(styleSel.value);
        syncStyleUI();
      });
      styleCustom.input.addEventListener('input', function () {
        imggen.setImgStyleCustom(styleCustom.get());
        syncStyleUI();
      });
      syncStyleUI();
      body.appendChild(gs.wrap);

      /* ---------- 接口 ---------- */
      var g = group('生图接口',
        '常规模型和 NAI 分开添加 —— 各有各的表单和内置预设。');
      var listCard = g.card;

      function refreshList() {
        listCard.innerHTML = '';
        var list = imggen.listApis();
        var act = imggen.activeApi();

        if (!list.length) {
          listCard.appendChild(row({ label: '还没有接口', plain: true }));
        } else {
          list.forEach(function (p) {
            var isCur = act && p.id === act.id;
            listCard.appendChild(row({
              label: p.name || '未命名接口',
              hint: (imggen.KINDS[p.kind] ? imggen.KINDS[p.kind].label : p.kind) +
                (p.model ? ' · ' + p.model : ''),
              badge: p.enabled === false ? '已停用' : (isCur ? '当前使用' : '备用'),
              badgeKind: p.enabled === false ? 'dim' : (isCur ? 'ok' : 'dim'),
              onClick: function () { ctx.open('settings-imggen-edit', { id: p.id }); }
            }));
          });
        }

        listCard.appendChild(row({
          label: '添加常规接口',
          hint: imggen.KINDS.general.hint,
          onClick: function () { ctx.open('settings-imggen-add', { kind: 'general' }); }
        }));
        listCard.appendChild(row({
          label: '添加 NAI',
          hint: imggen.KINDS.nai.hint,
          onClick: function () { ctx.open('settings-imggen-add', { kind: 'nai' }); }
        }));
        listCard.appendChild(row({
          label: '添加文字通道',
          hint: imggen.KINDS.chat.hint,
          onClick: function () { ctx.open('settings-imggen-add', { kind: 'chat' }); }
        }));
      }
      refreshList();
      body.appendChild(g.wrap);

      /* ---------- 提示词库 ---------- */
      var g2 = group('提示词库',
        '常用词条，生成时拼在提示词里。');
      var libCard = g2.card;
      var libFold = null;

      function refreshLib() {
        libCard.innerHTML = '';
        var list = imggen.listPrompts();
        if (!list.length) {
          libCard.appendChild(row({ label: '还没有词条', plain: true }));
        } else {
          list.forEach(function (p) {
            libCard.appendChild(row({
              label: p.name || p.text,
              hint: (p.cat || '其他') + ' · ' + p.text,
              onClick: function () { openLibForm(p); }
            }));
          });
        }
        libCard.appendChild(row({
          label: '添加词条',
          onClick: function () { openLibForm(null); }
        }));
        if (libFold) refreshLibBadge();
      }

      /* 词条表单：一条内嵌的可收起小卡（类别是下拉列表，不让人手打） */
      function openLibForm(editing) {
        if (libFold) { libFold.wrap.parentNode.removeChild(libFold.wrap); libFold = null; }
        libFold = foldGroup(editing ? '编辑词条' : '添加词条', '', true);
        libCard.appendChild(libFold.wrap);

        var fName = textField({ label: '名字', value: editing ? editing.name : '', placeholder: '例：胶片感' });
        libFold.body.appendChild(fName.el);
        var fText = textArea({ label: '词条内容（英文 tag 或一句话）', rows: 2, value: editing ? editing.text : '', placeholder: '例：film grain, muted colors' });
        libFold.body.appendChild(fText.el);

        /* 类别下拉 —— 用户：「改成可选，还是下拉列表」 */
        var catWrap = h('div', 'set-field');
        catWrap.appendChild(h('label', 'set-label', '类别'));
        var sel = h('select', 'set-select');
        imggen.PROMPT_CATS.forEach(function (c) {
          var opt = h('option', '', c);
          opt.value = c;
          if (editing && editing.cat === c) opt.selected = true;
          sel.appendChild(opt);
        });
        catWrap.appendChild(sel);
        libFold.body.appendChild(catWrap);

        var r = h('div', 'btn-row');
        r.appendChild(button('保存', 'primary', function () {
          var name = fName.get().trim();
          var text = fText.get().trim();
          var cat = sel.value;
          if (!name && !text) { ctx.toast('名字和内容总得填一个', 'err'); return; }
          if (editing) {
            editing.name = name;
            editing.text = text;
            editing.cat = cat;
            imggen.savePrompts(imggen.listPrompts());  /* 就地改，原引用落盘 */
          } else {
            imggen.addPrompt({ name: name, text: text, cat: cat });
          }
          libFold.wrap.parentNode.removeChild(libFold.wrap);
          libFold = null;
          refreshLib();
          ctx.toast('已保存', 'ok');
        }));
        r.appendChild(button('取消', 'ghost', function () {
          libFold.wrap.parentNode.removeChild(libFold.wrap);
          libFold = null;
        }));
        libFold.body.appendChild(r);
      }

      function refreshLibBadge() {
        /* 头部行右侧没有 badge，词条数在组说明里 —— 这里留空位 */
      }

      refreshLib();
      body.appendChild(g2.wrap);

      var foot = h('p', 'set-foot',
        'Key 只存在这台设备的浏览器里。锁脸档案在角色卡里设置（P1），'
        + '到时候锁脸用的参考图会上传给你配置的那个接口。');
      body.appendChild(foot);

      ctx.rebuild = refreshList;
    },
    onShow: function (ctx) {
      if (ctx.rebuild) ctx.rebuild();
    }
  });

  /* ==================== 接口表单（新增 / 编辑共用） ==================== */

  function renderForm(ctx, api, isNew) {
    var body = ctx.body;
    var kindLabel = imggen.KINDS[api.kind].label;

    var g = group('接口（' + kindLabel + '）', imggen.KINDS[api.kind].hint);
    var f = {};

    f.name = textField({ label: '备注名', value: api.name, placeholder: '' });
    g.card.appendChild(f.name.el);

    f.baseUrl = textField({
      label: api.kind === 'nai' ? '接口地址（一般不用改）' : '接口地址 Base URL',
      hint: api.kind === 'nai' ? 'NAI 官方地址，用中转再改' : '填到 /v1 就行',
      value: api.baseUrl,
      placeholder: api.kind === 'nai' ? 'https://image.novelai.net' : 'https://api.example.com/v1',
      inputmode: 'url'
    });
    g.card.appendChild(f.baseUrl.el);

    f.apiKey = textField({
      label: api.kind === 'nai' ? 'Persistent API Token' : 'API Key',
      hint: '明文存在本机浏览器，换设备不会跟着走',
      value: api.apiKey,
      placeholder: api.kind === 'nai' ? 'pst-...' : 'sk-...',
      password: true
    });
    g.card.appendChild(f.apiKey.el);

    if (api.kind === 'nai') {
      f.model = textField({
        label: '模型',
        hint: '点右边的按钮挑一个，也可以直接手填',
        value: api.model,
        placeholder: 'nai-diffusion-3'
      });
      g.card.appendChild(f.model.el);
      /* NAI 这一支没有接口可拉，模型名是内置的 4 个。
         仍然走同一枚按钮 + 同一个浮层 —— 以前是把 4 行列在字段下面，
         和别的分支两种交互（用户要的是「别铺在页面上」，统一成浮层）。
         ⚠️ 待办（审查报告一.4）：这里以后应该也能拉 /ai/models。 */
      f.model.el.querySelector('.set-line').appendChild(ui.modelPickButton({
        tip: 'Nightly 内置的这几个；接口支持的话也能直接手填',
        load: function () {
          return { ok: true, models: (imggen.NAI_MODELS || []).slice() };
        },
        onPick: function (m) { f.model.input.value = m; }
      }));
    } else {
      f.model = textField({ label: '模型名', value: api.model, placeholder: '' });
      g.card.appendChild(f.model.el);

      /* 拉取模型是模型名旁边的小圆钮（用户：「能简化成小的按钮会更舒适」），
         调 {base}/models，用表单里当前的地址和 Key，不用先保存。
         结果走**浮层**：拉一次可能回 60 个，铺在页面里整页会被拉长。 */
      f.model.el.querySelector('.set-line').appendChild(ui.modelPickButton({
        load: function () {
          return Sleepy.api.fetchModels({ baseUrl: f.baseUrl.get(), apiKey: f.apiKey.get() });
        },
        onPick: function (id) { f.model.input.value = id; }
      }));
    }

    f.size = textField({
      label: '尺寸',
      hint: '宽x高，例 1024x1024（NAI 竖图常用 832x1216）',
      value: api.size,
      placeholder: '1024x1024'
    });
    g.card.appendChild(f.size.el);

    f.timeoutSec = numField({ label: '超时（秒）', hint: '最小 60 —— 小于 60 的值运行时也会按 60 跑', value: api.timeoutSec, min: 60, max: 600, step: 10 });
    g.card.appendChild(f.timeoutSec.el);

    /* B2 图片锁脸（2026-10-02 施工单 §5）：参考图支持由用户按服务方能力
       显式声明，不做 kind 上的想当然。none = 不支持/未核实（默认）——
       图片锁脸启用时会明确拦下提示，绝不盲发。 */
    f.refSupport = h('div', 'set-field');
    f.refSupport.appendChild(h('label', 'set-label', '参考图支持（图片锁脸用）'));
    var refSel = h('select', 'set-select');
    [['none', '不支持 / 未核实（默认）'],
     ['edits', '通用：支持 /images/edits 参考图（general 接口选这个）'],
     ['chat', '文字通道：多模态送图（chat 接口选这个）']].forEach(function (o) {
      var op = h('option', '', o[1]);
      op.value = o[0];
      if ((api.refSupport || 'none') === o[0]) op.selected = true;
      refSel.appendChild(op);
    });
    f.refSupport.appendChild(refSel);
    f.refSupport.appendChild(h('p', 'set-hint',
      'NAI 暂不支持图片锁脸。按服务方实际能力选，选错会在生图时报原文错误。'));
    g.card.appendChild(f.refSupport);   /* 裸 div 没有 .el —— 直接挂自身 */
    body.appendChild(g.wrap);

    /* ---------- 内置预设（可改） ---------- */
    var g2 = group('预设词',
      '新建时按模型特色带的起手式，{p} 是「这回画什么」的位置。想改就改，不影响别人。');
    f.positivePreset = textArea({
      label: '正面预设', rows: 2, value: api.positivePreset,
      hint: '{p} = 锁脸 + 这次的内容 + 勾的词条'
    });
    g2.card.appendChild(f.positivePreset.el);
    f.negativePreset = textArea({
      label: '负面预设（不想要什么）', rows: 2, value: api.negativePreset
    });
    g2.card.appendChild(f.negativePreset.el);
    body.appendChild(g2.wrap);

    var g3 = group('开关');
    f.enabled = switchField({ label: '启用这个接口', value: api.enabled !== false });
    g3.card.appendChild(f.enabled.el);
    /* 「当前使用」：生成走哪一套。新增时不给（存完自动成为当前）——
       用户要的「可以保存的 API 预设」：存好几套、随时切当前，
       和主 API 的多预设同一个交互。 */
    f.isCurrent = null;
    if (!isNew) {
      f.isCurrent = switchField({
        label: '当前使用这套',
        hint: '关掉会自动把「当前」让给列表里的第一套别的',
        value: !!(imggen.activeApi() && imggen.activeApi().id === api.id)
      });
      g3.card.appendChild(f.isCurrent.el);
    }
    body.appendChild(g3.wrap);

    /* ---------- 试一张（就在这个接口下面试：用的是表单里当前的值，
       不用先保存。用户：「放到加 api 的下面去测试」） ---------- */
    var tryFold = foldGroup('试一张',
      '用上面表单里当前的配置直接画一张，画好自动收进图库。', false);
    body.appendChild(tryFold.wrap);

    var subj = textArea({
      label: '想画什么',
      hint: '预设词会自动拼进去，这里只管「这一张」的内容',
      rows: 2,
      placeholder: '例：坐在窗边的女孩，午后阳光，喝咖啡，毛衣'
    });
    tryFold.body.appendChild(subj.el);

    /* ---- E1 本地实验：视觉拼接模式（仅试一张，未接入其他生图入口）----
       legacy = 完全旧路径对照；sleepy-default = Sleepy 场景/物品底座；
       custom = 只注入用户自定义视觉词（空 = 没有额外审美词，不回退默认）。
       实验字段存 sleepy_img_visual_exp_*，不进接口配置、不进导出。 */
    tryFold.body.appendChild(h('p', 'test-tip', '仅本地实验，未接入其他生图入口'));

    var expModeWrap = h('div', 'set-field');
    expModeWrap.appendChild(h('label', 'set-label', '视觉拼接模式'));
    var expModeSel = h('select', 'set-select');
    [['legacy', '当前旧基底（对照）'],
     ['sleepy-default', 'Sleepy 默认底座（实验）'],
     ['custom', '用户自定义视觉词（实验）']].forEach(function (o) {
      var op = h('option', '', o[1]);
      op.value = o[0];
      expModeSel.appendChild(op);
    });
    expModeSel.value = imggen.visualExpMode();
    expModeWrap.appendChild(expModeSel);
    ui.bindLabel(expModeWrap, expModeSel);
    tryFold.body.appendChild(expModeWrap);

    var customVisual = textArea({
      label: '自定义视觉提示词',
      hint: '只替换 Sleepy 的视觉审美层；不会关闭画面内容与无人结构。',
      rows: 3,
      placeholder: '例：flat graphic illustration, limited color palette'
    });
    customVisual.input.value = imggen.visualExpCustom();
    tryFold.body.appendChild(customVisual.el);

    /* ---- E2 单人角色实验：真实主体 + 镜头 + 手部是否入镜（仅试一张）----
       主体只能从**本岛名册**里挑（角色 / 我的马甲），读的是 B1 那套
       subjectForChar / subjectForUser —— 不让人手抄身份、也不写 JSON，
       更不靠「想画什么」里的关键词去猜画面里有人。
       小号/皮套/NPC 暂不给选项：B0 的 subjects 只认 user/char 两种
       entityType（imggen.normalizePlan），NPC 没有可复用的主体类型。 */
    /* options 里允许一项写成 { group:'标签', items:[[值,文案],…] } → 渲染成
       <optgroup>（「已有角色／马甲」那一组用它，跟上面两条基础选项分开）。 */
    function expSelect(labelText, options, cur, onPick) {
      var wrap = h('div', 'set-field');
      wrap.appendChild(h('label', 'set-label', labelText));
      var sel = h('select', 'set-select');
      function addTo(items, parent) {
        items.forEach(function (o) {
          var op = h('option', '', o[1]);
          op.value = o[0];
          parent.appendChild(op);
        });
      }
      options.forEach(function (o) {
        if (o && o.group) {
          var og = h('optgroup', '');
          og.label = o.group;
          addTo(o.items, og);
          sel.appendChild(og);
        } else {
          addTo([o], sel);
        }
      });
      sel.value = cur;
      wrap.appendChild(sel);
      ui.bindLabel(wrap, sel);
      sel.addEventListener('change', function () { onPick(sel.value); });
      return { el: wrap, sel: sel };
    }

    /* 三类主体（2026-09-30 入口调整）：把「测底座」和「联调锁脸」分开，
       没岛 / 没角色 / 没马甲也能直接测普通单人。 */
    var realIdentities = [];
    var sb = core.activeSandbox();
    core.charsOfSandbox(sb).forEach(function (c) {
      realIdentities.push(['char:' + c.id, '角色 · ' + (c.name || '未命名')]);
    });
    core.masksOfSandbox(sb).forEach(function (u) {
      realIdentities.push(['user:' + u.id, '我 · ' + (core.labelOfUser(u) || '我')]);
    });
    var subjOptions = [
      ['', '无人场景／物品（走 01 底座）'],
      [imggen.TEMP_SINGLE_REF, '单人（临时测试，不读取角色资料）'],
      [imggen.TEMP_TWO_REF, '双人（临时测试，不读取角色资料）'],
      [imggen.TEMP_GROUP_REF, '多人（临时测试，不读取群岛资料）']
    ];
    if (realIdentities.length) {
      subjOptions.push({ group: '已有角色／马甲（锁脸联调）', items: realIdentities });
    }

    /* 只有**本岛名册里**的 ref（外加临时单人哨兵）才算有效。
       岛间隔绝不放松：这里**不**退化成「读全部角色」。 */
    /* 临时哨兵也算「有效主体」—— 否则选过双人 / 多人后重开页面，
       存的 ref 会被判成「不在本岛」，生成时误报「这个主体已经不在本岛或已被删除」。
       （@temp-two 是上一轮遗留的同口径隐患，一并补上，别让双人路也踩。） */
    var allowedRefs = {};
    allowedRefs[imggen.TEMP_SINGLE_REF] = true;
    allowedRefs[imggen.TEMP_TWO_REF] = true;
    allowedRefs[imggen.TEMP_GROUP_REF] = true;
    realIdentities.forEach(function (o) { allowedRefs[o[0]] = true; });

    /* 存的那个主体如果已经不在本岛（切岛 / 被删），**不许悄悄变成「没有人」** ——
       留一个显眼的失效项摆在那儿，点了生成会拦下来让人重选。 */
    var savedRef = imggen.singleExpSubjectRef();
    if (savedRef && !allowedRefs[savedRef]) {
      subjOptions.push([savedRef, '（已失效：不在本岛或已被删除，请重选）']);
    }

    /* ref → 真实主体。不在本岛名册 / 记录已删 → null，调用方拦下来，
       **绝不静默换成别人，也绝不回落成「没有人」的无人图**。 */
    function subjectForRef(ref, shot) {
      if (!ref || !allowedRefs[ref]) return null;
      if (ref.indexOf('char:') === 0) {
        var ch = core.findChar(ref.slice(5));
        return ch ? imggen.subjectForChar(ch, shot) : null;
      }
      if (ref.indexOf('user:') === 0) {
        var u = core.findUser(ref.slice(5));
        return u ? imggen.subjectForUser(u, shot) : null;
      }
      return null;
    }

    var subjPick = expSelect('主体', subjOptions,
      savedRef, function (v) { imggen.setSingleExpSubjectRef(v); });
    tryFold.body.appendChild(subjPick.el);

    /* 名册为空时**明确说一句**，别让人对着空下拉猜 ——
       但不影响「单人（临时测试）」。绝不靠「读全部角色」来填满下拉。 */
    if (!realIdentities.length) {
      tryFold.body.appendChild(h('p', 'test-tip',
        '现在没有可选的角色／马甲（本岛名册为空）。想联调锁脸，先去建人并把他加进当前岛；'
        + '只想测底座，用上面的「单人（临时测试）」就行。'));
    }

    /* 临时单人的性别：真实枚举 '' / 'female' / 'male'，与 genderTagOf 同档。
       选真实身份时这一项不参与（身份自带 gender）。 */
    var genderPick = expSelect('性别（临时单人）', [
      ['', '不指定'],
      ['female', '女'],
      ['male', '男']
    ], imggen.singleExpGender(), function (v) { imggen.setSingleExpGender(v); });
    tryFold.body.appendChild(genderPick.el);

    /* ---- 03 临时双人：人物A / 人物B 两个**独立**描述框（都必填）----
       两个人的资料都是**临时实验数据**：只进 buildTwoSubjectExperimentPrompt，
       不写真实角色存储、不建岛 / 建角色 / 建马甲、也不伪造 user/char 引用 ——
       用户不用为此先准备任何真实身份。
       「谁在哪边 / 看谁 / 手递给谁 / 有没有接触」没有专用结构位，
       统一由上面的「想画什么」+ 这两人的外貌衣着，用「人物A / 人物B」指代。 */
    var twoHint = h('p', 'set-hint',
      '本轮双人先验证结构，默认视觉底座待定稿，视觉层固定走自定义视觉词。'
      + '「常规生图」「文字通道」两种接口都支持；镜头固定「按画面描述」，'
      + '不产生隐含镜头词；手部动作也请在画面描述里写明。');
    var paPick = textArea({
      label: '人物A（临时测试，必填）',
      hint: '写年龄、性别、外貌、衣着，例：30 岁成年人，黑色短发，深蓝外套。'
        + '只属于本次实验，不写入任何角色资料。',
      rows: 2
    });
    var pbPick = textArea({
      label: '人物B（临时测试，必填）',
      hint: '同上，例：60 岁女性，栗色肩长发，米色上衣。'
        + '与人物A 各自一层独立保留，不会被合并或互相覆盖。',
      rows: 2
    });
    /* ---- 04 临时多人群像：人物A / B 复用双人那两个框，C / D 另开 ----
       A、B 复用双人的框，是为了「切回双人时原输入不被覆盖」；C、D 默认收起，
       点「添加人物」逐个放出来（上限 imggen.GROUP_MAX = 4）。
       人物资料只进 buildGroupSubjectExperimentPrompt：不写角色 / 群岛 / 马甲 /
       长期记忆，也不伪造 user/char 引用。人物块各自一层，不合并、不互相覆盖。 */
    var groupHint = h('p', 'set-hint',
      '本轮群像只验证三件事：人数、每个人是否各自成块（身份分块）、'
      + '共同事件与动作归属有没有保留。'
      + '视觉层固定走自定义视觉词，镜头固定「按画面描述」（不使用单人镜头下拉），'
      + '系统手部附加词关闭；「常规生图」「文字通道」都支持。'
      + '少于 3 人不发、超过 4 人不接，也不会替你补人或静默减员。');
    var gcPick = textArea({
      label: '人物C（临时测试，本轮可选，凑 3 人起）',
      hint: '写年龄、性别、外貌、衣着，例：60 岁女性，花白短发，深咖啡色围裙。'
        + '只属于本次实验，不写入任何角色 / 群岛资料。',
      rows: 2
    });
    var gdPick = textArea({
      label: '人物D（临时测试，本轮可选，最多 4 人）',
      hint: '同上。写不下就用 3 个人；本轮不接第 5 人。',
      rows: 2
    });
    /* 当前露出来的人物数（2 → 3 → 4），只由「添加人物」按钮推进 */
    var groupCount = 2;
    var groupPicks = [paPick, pbPick, gcPick, gdPick];
    var addBtn = button('添加人物', 'ghost', function () {
      if (groupCount >= imggen.GROUP_MAX) return;
      groupCount = Math.min(imggen.GROUP_MAX, groupCount + 1);
      syncGroup();
    });
    /* 到上限后「添加人物」锁死（本轮不接第 5 人），但必须有回到 3 人的路：
       否则一旦放出 D，人物数就卡在 4，想画三人组只能把 D 填上凑数或一直卡着。
       所以上限时同时露出一个「收起第 4 位」，点了把人数退回 3 并清空 D。 */
    var foldBtn = button('收起第 4 位（回到 3 人）', 'ghost', function () {
      if (groupCount < imggen.GROUP_MAX) return;
      groupCount = imggen.GROUP_MAX - 1;
      groupPicks[imggen.GROUP_MAX - 1].input.value = '';
      syncGroup();
    });
    foldBtn.style.display = 'none';
    var addRow = h('div', 'btn-row');
    addRow.appendChild(addBtn);
    /* 收起按钮单独占一行：addRow 在到上限时会整行收起，
       塞在它旁边会跟着一起被藏掉，回退就点不到了。 */
    var foldRow = h('div', 'btn-row');
    foldRow.appendChild(foldBtn);
    /* C / D 的显隐**只由「添加人物」决定**，不被 syncExpUI 的 two / group 显隐
       顺手改掉 —— 否则切走再切回来会漏出未填写的人物框。 */
    function syncGroup() {
      gcPick.el.style.display = (groupCount >= 3) ? '' : 'none';
      gdPick.el.style.display = (groupCount >= 4) ? '' : 'none';
      addBtn.textContent = (groupCount >= imggen.GROUP_MAX)
        ? '已经到上限（' + imggen.GROUP_MAX + ' 人）'
        : (groupCount < imggen.GROUP_MIN ? '添加人物' : '再加一位（最多 '
          + imggen.GROUP_MAX + ' 人）');
      addBtn.disabled = (groupCount >= imggen.GROUP_MAX);
      /* 上限时「添加人物」锁死并整行收起，回退交给独立那一行的 foldBtn */
      addRow.style.display = (groupCount >= imggen.GROUP_MAX) ? 'none' : '';
      foldRow.style.display = (groupCount >= imggen.GROUP_MAX) ? '' : 'none';
      foldBtn.style.display = (groupCount >= imggen.GROUP_MAX) ? '' : 'none';
    }
    syncGroup();

    /* 选了双人时的接口提示（点了生成还会再拦一次，这里是先说清楚，
       别让人点了半天没反应）。
       General / 文字通道（chat）都放行 —— 两条路吃的是同一份双人提示词，
       差别只在**负面怎么送**：general 走独立 negative_prompt 字段，
       chat 拼成自然语言「画面里不要出现这些要素」那一句（requestChat）。
       只有 NAI 本轮不支持（它有独立的 ucPreset 结构，拼接口径另议）。 */
    var twoApiWarn = h('p', 'set-hint', '');
    function twoApiWarnText(kind, isGroup) {
      var label = ((imggen.KINDS[kind] || {}).label) || kind || '未知';
      var who = isGroup ? '多人（3～4 人）' : '双人';
      var count = isGroup ? '3～4 个各自独立的人物块 + 共同画面描述 + 群像结构 + 只有质量负面'
        : '两个人物 + 场景 + 最小双人结构 + 只有质量负面';
      if (kind === 'chat') {
        return '当前是「' + label + '」接口：' + who + '提示词与「常规生图」完全一样（'
          + count + '），只是它会以自然语言整段发到 /chat/completions，'
          + '负面跟在后面而不是独立字段；切回「常规生图」才走独立 negative_prompt。';
      }
      return '当前是「' + label + '」接口：临时' + who + '本轮不支持这个接口，'
        + '切到「常规生图」或「文字通道」再试。';
    }
    twoApiWarn.style.display = 'none';
    tryFold.body.appendChild(twoHint);
    tryFold.body.appendChild(twoApiWarn);
    tryFold.body.appendChild(groupHint);
    tryFold.body.appendChild(paPick.el);
    tryFold.body.appendChild(pbPick.el);
    tryFold.body.appendChild(gcPick.el);
    tryFold.body.appendChild(gdPick.el);
    tryFold.body.appendChild(addRow);
    tryFold.body.appendChild(foldRow);

    var shotPick = expSelect('镜头', [
      ['auto', '不指定'],
      ['selfie', '自拍／近距离'],
      ['portrait', '半身／肖像'],
      ['full', '全身'],
      ['candid', '生活抓拍']
    ], imggen.singleExpShot(), function (v) { imggen.setSingleExpShot(v); });
    tryFold.body.appendChild(shotPick.el);

    var handsPick = expSelect('手部是否入镜', [
      ['unspecified', '未指定（不追加手部词）'],
      ['visible', '手明确可见'],
      ['hidden', '手明确不入镜']
    ], imggen.singleExpHands(), function (v) { imggen.setSingleExpHands(v); });
    tryFold.body.appendChild(handsPick.el);
    /* 手部下拉当前**只记录选择**：系统附加手部段已整体关闭
       （imggen.visibleHandsText 恒返回空串，见 imggen.js 该处注释）。
       如实说明，免得用户以为选了「手明确可见」就等于在请求里追加了手部要求。
       hands 原值照旧存（snap.hands），不改成 hidden / unspecified；
       不新增提示词、不建动作解析器、不改写用户描述。 */
    tryFold.body.appendChild(h('p', 'set-hint',
      '当前仅记录选择，不单独控制手部入镜；请在画面描述中写明。'));

    /* 双人目录下**局部**强制 custom（施工单 §一 4）：只把下拉摆成 custom 并锁住，
       **不写** setVisualExpMode —— 全局保存的视觉模式一个字节都不动；
       切回单人时把锁之前那个值原样放回去（含 enabled）。 */
    var twoSavedExpMode = '';
    function syncExpUI() {
      /* 主体 / 镜头 / 手部只在非 legacy 模式下有意义（legacy 是旧路对照组） */
      var on = expModeSel.value !== 'legacy';
      var ref = subjPick.sel.value;
      var two = (ref === imggen.TEMP_TWO_REF);
      var group = (ref === imggen.TEMP_GROUP_REF);
      var multi = two || group;      /* 临时多人群像与双人同档：锁 custom + 收镜头 */

      if (multi) {
        if (expModeSel.value !== 'custom') {
          if (!twoSavedExpMode) twoSavedExpMode = expModeSel.value;
          expModeSel.value = 'custom';
          expModeSel.disabled = true;
        }
      } else if (expModeSel.disabled) {
        /* 切回单人：恢复锁之前的模式与原启用状态，01 / E2 原样可用 */
        expModeSel.value = twoSavedExpMode || 'legacy';
        twoSavedExpMode = '';
        expModeSel.disabled = false;
      }

      /* 自定义视觉词输入：custom 模式露面；双人本轮只测 custom，也要露面。
         其余模式（legacy / sleepy-default）**维持原来的收起行为**，没动。 */
      customVisual.el.style.display = (expModeSel.value === 'custom' || multi) ? '' : 'none';
      /* 主体 / 镜头 / 手部在 legacy 下收起（这条显隐规则**没动**，双人照它走）；
         非 legacy 且不是双人时才展开镜头 / 手部 —— 双人本轮镜头固定「按画面描述」 */
      [subjPick.el, shotPick.el, handsPick.el].forEach(function (el) {
        el.style.display = on ? '' : 'none';
      });
      [shotPick.el, handsPick.el].forEach(function (el) {
        el.style.display = (on && !two) ? '' : 'none';
      });
      /* 性别只在「单人（临时测试）」下露面 */
      genderPick.el.style.display =
        (on && !two && ref === imggen.TEMP_SINGLE_REF) ? '' : 'none';
      /* 人物A / 人物B 只在双人**或**多人下露面（都必填，缺一个点生成会拦下来） */
      [twoHint, twoApiWarn, paPick.el, pbPick.el, groupHint].forEach(function (el) {
        el.style.display = multi ? '' : 'none';
      });
      /* 群像的 C / D 与「添加人物」**只**由 syncGroup 管 —— 这里顺手置灰，
         免得刚切到群像就漏出还没填写的人物框（会被当成空人物拦下来） */
      gcPick.el.style.display = 'none';
      gdPick.el.style.display = 'none';
      addRow.style.display = 'none';
      foldRow.style.display = 'none';
      if (group) syncGroup();
      /* 临时双人 / 多人下任何接口都会写一段说明：放行的那条讲清负面怎么送，
         不支持的讲明去哪切。文字按「双人 / 多人」各写一份，别串词。 */
      twoApiWarn.textContent = twoApiWarnText(api.kind, group);
      twoApiWarn.style.display = multi ? '' : 'none';
    }
    subjPick.sel.addEventListener('change', function () { syncExpUI(); });
    expModeSel.addEventListener('change', function () {
      imggen.setVisualExpMode(expModeSel.value);
      syncExpUI();
    });
    customVisual.input.addEventListener('input', function () {
      imggen.setVisualExpCustom(customVisual.get());
    });
    syncExpUI();

    var tryBtnRow = h('div', 'btn-row');
    var genBtn = button('生成', 'primary');
    tryBtnRow.appendChild(genBtn);
    tryFold.body.appendChild(tryBtnRow);

    var out = h('div', 'imggen-out');
    tryFold.body.appendChild(out);

    genBtn.addEventListener('click', function () {
      var subject = subj.get().trim();
      if (!subject) { ctx.toast('先写一句想画什么', 'err'); return; }
      genBtn.disabled = true;
      out.className = 'imggen-out is-loading';
      out.innerHTML = '';
      out.appendChild(h('p', 'test-tip', '正在画…（生图要几秒到几十秒）'));

      /* 用表单里当前的值（还没保存也行）；词条全拼上，
         正式的勾选入口在聊天里（P1）。
         E1：legacy 走原路径分毫不动；新模式显式构造 subjects:[] 的
         scene plan（不靠 PERSON_RE），prompt 由实验函数拼好直进请求。 */
      var extras = imggen.listPrompts().map(function (p) { return p.text; });
      var expMode = imggen.visualExpMode();
      /* 临时双人本轮固定用 custom 这档拼接器 —— 但**只在这一次生成里**，
         不落地、不调 setVisualExpMode：全局保存的 visualMode 一个字节都不动，
         切回单人依旧是原模式、原输入（施工单 §一 4）。 */
      var expModeUsed = (subjPick.sel.value === imggen.TEMP_TWO_REF
        || subjPick.sel.value === imggen.TEMP_GROUP_REF) ? 'custom' : expMode;
      /* **点击瞬间**就把这次的参数快照下来（不靠异步回调里再读可变 DOM）——
         回显的「本次生成参数」与实际请求用的是同一份值。不含任何密钥。 */
      var snap = {
        mode: expModeUsed,
        ref: '',
        two: false,
        group: false,
        personCount: 0,
        apiKind: '',
        temp: false,
        gender: '',
        shot: shotPick.sel.value,
        hands: handsPick.sel.value,
        layer: expModeUsed === 'legacy' ? 'legacy' : expModeUsed,
        handsVer: 'none'
      };
      var req;
      if (expModeUsed === 'legacy') {
        req = imggen.generate({ api: collect(), subject: subject, extras: extras });
      } else {
        /* E1：没人 → 场景/物品底座（subjects:[]）；
           E2：选了主体 → 用真实名册记录造**一个**主体走单人底座。
           legacy 走原路径分毫不动；实验 prompt 拼好直进请求。 */
        var ref = subjPick.sel.value;
        var two = (ref === imggen.TEMP_TWO_REF);
        var group = (ref === imggen.TEMP_GROUP_REF);
        var shot = shotPick.sel.value;
        var built;
        snap.ref = ref;
        snap.two = two;
        snap.group = group;
        snap.temp = ref === imggen.TEMP_SINGLE_REF;
        snap.gender = snap.temp ? genderPick.sel.value : '';

        /* ---- 04 临时多人群像：走 buildGroupSubjectExperimentPrompt ----
           与双人同档的守卫：只 General / chat，两人以上**必须**露出来且都非空，
           缺一个就一步请求都不发（不 filter 掉空的、不补人、不静默减成双人）。 */
        if (group) {
          var gApi = collect();
          snap.apiKind = gApi.kind;
          if (gApi.kind !== 'general' && gApi.kind !== 'chat') {
            genBtn.disabled = false;
            out.className = 'imggen-out is-err';
            out.innerHTML = '';
            out.appendChild(h('p', 'test-title', '临时多人本轮只支持 General / 文字通道接口'));
            out.appendChild(h('p', 'test-tip', '当前是「'
              + ((imggen.KINDS[gApi.kind] || {}).label || gApi.kind || '未知')
              + '」接口：切到「常规生图」或「文字通道」的「试一张」再生成。'));
            return;
          }
          /* 露出来的人物**逐个都必填**：点过「添加人物」的那个框空着，
             就报「人物X 还没写」——**不许把他 filter 掉、减员成 3 人继续出图**
             （施工单 §二：空主体不能被 filter 掉后继续出图）。 */
          var gsubs = [];
          var gname = '';
          for (var gi = 0; gi < groupCount; gi++) {
            var gv = String(groupPicks[gi].get() || '').trim();
            if (!gv) {
              if (!gname) gname = imggen.GROUP_LABELS[gi];
              continue;                      /* 继续扫完，报错一次说清楚是哪一个 */
            }
            gsubs.push({ label: imggen.GROUP_LABELS[gi], description: gv });
          }
          /* 露出来的人物里有一个空的（例如点了「添加人物」放出 D 却没写）：
             **整单拦下** —— 不许把这份空的 filter 掉、减员成 3 人接着出图。
             报「人物X 还没写」，并把「不自动补人」讲明白。 */
          if (gname) {
            genBtn.disabled = false;
            out.className = 'imggen-out is-err';
            out.innerHTML = '';
            out.appendChild(h('p', 'test-title', '人物' + gname + ' 还没写'));
            out.appendChild(h('p', 'test-tip',
              '「人物' + gname + '」是空的：点出来的人都要各写一份年龄、性别、外貌、衣着；'
              + '空的人物不会被自动补上、也不会被悄悄减掉，补完（或别点「添加人物」）再生成。'));
            return;
          }
          /* 少于 3 人本轮不接：不静默减成双人，也不替用户补一个人 */
          if (gsubs.length < imggen.GROUP_MIN) {
            genBtn.disabled = false;
            out.className = 'imggen-out is-err';
            out.innerHTML = '';
            out.appendChild(h('p', 'test-title',
              gname ? ('人物' + gname + '还没写') : ('群像至少要 ' + imggen.GROUP_MIN + ' 个人物')));
            out.appendChild(h('p', 'test-tip',
              gname ? ('「人物' + gname + '」是空的 —— 空的人物不会被自动补上，'
                + '点「添加人物」放一个出来再填，或者回到双人。')
                : ('本轮群像只做 ' + imggen.GROUP_MIN + '～' + imggen.GROUP_MAX + ' 人，'
                  + '点「添加人物」凑够 ' + imggen.GROUP_MIN + ' 个再生成。')));
            return;
          }
          var gBuilt = imggen.buildGroupSubjectExperimentPrompt({
            api: gApi,
            description: subject,
            tempGroup: true,
            tempSubjects: gsubs,
            visualMode: expModeUsed,
            customVisualStyle: imggen.visualExpCustom(),
            extras: extras
          });
          if (!gBuilt) {                        /* 纯函数层的兜底守卫 */
            genBtn.disabled = false;
            out.className = 'imggen-out is-err';
            out.innerHTML = '';
            out.appendChild(h('p', 'test-title', '这个模式不能画这张'));
            out.appendChild(h('p', 'test-tip', '人数或模式不符合群像实验的约束（'
              + imggen.GROUP_MIN + '～' + imggen.GROUP_MAX + ' 人，且都要写）。'));
            return;
          }
          /* 与双人同构：只把 built 递给下面公用的 generateBuilt 那一行，
             请求与结果渲染都走原有的那一条路，不另开一套。 */
          built = gBuilt;
          snap.shot = 'auto';
          snap.personCount = gsubs.length;
          snap.layer = 'custom';
          snap.handsVer = gBuilt.debug ? gBuilt.debug.handsVersion : 'off';
          snap.custom = gBuilt.debug ? gBuilt.debug.customVisual : '(空)';
        }

        /* ---- 03 临时双人：走 buildTwoSubjectExperimentPrompt ----
           两人都是临时描述，不读角色 / 马甲资料；镜头本轮固定「按画面描述」
           （shot 显式记成 auto，不取被隐藏的单人镜头下拉）。 */
        /* 群像分支是**这个 else 块里的链首**（不是外层 if 的 else）：
           外层 `if (legacy) … else { … }` 的 else 块已是 Block 语句，
           再往外挂 `} else if` 会被解析成「一个 if 挂两个 else」→ 语法错误。
           链尾走完自然落到下面公用的 generateBuilt 那一行，不另开请求路径。 */
        else if (two) {
          var twoApi = collect();
          snap.apiKind = twoApi.kind;
          if (twoApi.kind !== 'general' && twoApi.kind !== 'chat') {
            genBtn.disabled = false;
            out.className = 'imggen-out is-err';
            out.innerHTML = '';
            out.appendChild(h('p', 'test-title', '临时双人本轮只支持 General / 文字通道接口'));
            out.appendChild(h('p', 'test-tip', '当前是「'
              + ((imggen.KINDS[twoApi.kind] || {}).label || twoApi.kind || '未知')
              + '」接口：切到「常规生图」或「文字通道」的「试一张」再生成。'));
            return;
          }
          var pa = String(paPick.get() || '').trim();
          var pb = String(pbPick.get() || '').trim();
          /* 两个人物都必填：**缺一个就一步请求都不发**（不 filter 掉空的继续出图） */
          if (!pa || !pb) {
            genBtn.disabled = false;
            out.className = 'imggen-out is-err';
            out.innerHTML = '';
            out.appendChild(h('p', 'test-title', '人物A 和人物B 都要写'));
            out.appendChild(h('p', 'test-tip', '上面两个框各写一个人的年龄、性别、外貌、衣着；'
              + '缺一个就不会发请求，也不会替你补一个人上去。'));
            return;
          }
          built = imggen.buildTwoSubjectExperimentPrompt({
            api: twoApi,
            description: subject,
            tempTwo: true,
            tempSubjects: [{ label: 'A', description: pa }, { label: 'B', description: pb }],
            visualMode: expModeUsed,
            customVisualStyle: imggen.visualExpCustom(),
            extras: extras
          });
          snap.shot = 'auto';
          snap.layer = 'custom';
          snap.handsVer = (built && built.debug) ? built.debug.handsVersion : 'off';
          snap.custom = built && built.debug ? built.debug.customVisual : '(空)';
        } else if (!ref) {
          built = imggen.buildSceneObjectExperimentPrompt({
            api: collect(),
            description: subject,
            contentType: 'scene',
            subjects: [],
            visualMode: expModeUsed,
            customVisualStyle: imggen.visualExpCustom(),
            extras: extras
          });
          snap.layer = expMode;
        } else if (ref === imggen.TEMP_SINGLE_REF) {
          /* 临时单人：不读任何角色 / 马甲资料，性别只在实验里拼。
             没岛、没角色、没马甲也能用。 */
          var tempOpts = {
            api: collect(),
            description: subject,
            shot: shot,
            tempSingle: true,
            gender: snap.gender,
            visualMode: expModeUsed,
            customVisualStyle: imggen.visualExpCustom(),
            hands: snap.hands,
            extras: extras
          };
          /* 视觉层版本走 imggen 的同一个判定，页面不自己再写一遍 */
          snap.layer = imggen.singleVisualLayerOf(tempOpts);
          built = imggen.buildSingleSubjectExperimentPrompt(tempOpts);
          snap.handsVer = (built && built.debug) ? built.debug.handsVersion : 'none';
        } else {
          var one = subjectForRef(ref, shot);
          /* 主体查不到（切岛 / 被删）：**拦下来让人重选** ——
             不静默换成别人，也不回落成「没有人」的无人图。 */
          if (!one) {
            genBtn.disabled = false;
            out.className = 'imggen-out is-err';
            out.innerHTML = '';
            out.appendChild(h('p', 'test-title', '这个主体已经不在本岛或已被删除'));
            out.appendChild(h('p', 'test-tip', '重新在「单人主体」里选一个再生成。'));
            return;
          }
          built = imggen.buildSingleSubjectExperimentPrompt({
            api: collect(),
            description: subject,
            shot: shot,
            subjects: [one],
            visualMode: expModeUsed,
            customVisualStyle: imggen.visualExpCustom(),
            hands: handsPick.sel.value,
            extras: extras
          });
          snap.layer = expMode;
          snap.handsVer = (built && built.debug) ? built.debug.handsVersion : 'none';
        }
        req = (built && imggen.generateBuilt({
          api: collect(), positive: built.positive, negative: built.negative
        })) || Promise.resolve({ ok: false, error: { message: '这个模式不能画这张', detail: '' } });
      }
      req.then(function (res) {
        genBtn.disabled = false;
        out.innerHTML = '';                 /* 清掉「正在画…」 */
        out.appendChild(paramLine(snap));   /* 结果旁回显这次真实用到的参数 */
        if (!res.ok) {
          out.className = 'imggen-out is-err';
          out.appendChild(h('p', 'test-title', res.error.message));
          var copyRow = h('div', 'btn-row');
          var copyBtn = button('复制报错详情', 'ghost', function () {
            var full = res.error.message + (res.error.detail ? '\n' + res.error.detail : '');
            copyText(full, copyBtn);
          });
          copyRow.appendChild(copyBtn);
          out.appendChild(copyRow);
          if (res.error.detail) out.appendChild(h('p', 'test-detail', res.error.detail));
          out.appendChild(h('p', 'test-tip',
            '把上面的详情复制下来，拿去反馈给你配的接口提供方就行。'));
          return;
        }
        out.className = 'imggen-out is-ok';
        var done = function (u) {
          var img = h('div', 'imggen-pic');
          img.style.backgroundImage = 'url("' + String(u).replace(/"/g, '%22') + '")';
          /* 点图看原图（2026-10-01 取证后补）：预览容器是 1:1 + cover
             （style.css .imggen-pic），非方图在这里**必然被裁一刀**——
             「没生好还是被裁了」必须看原图才能分清。
             复用 ui.imageViewer（聊天消息大图同款，object-fit:contain 不裁）。
             纯显示层行为，不碰任何请求 / 拼接逻辑。 */
          img.style.cursor = 'zoom-in';
          img.setAttribute('role', 'button');
          img.setAttribute('aria-label', '点开看原图');
          img.addEventListener('click', function () {
            if (u) ui.imageViewer(String(u), { alt: '生图结果（原图）' });
          });
          out.appendChild(img);
          out.appendChild(h('p', 'test-tip',
            '预览按正方形裁切显示；点图看原图——原图上人脸全不全，才是生成本身的事。'));
          if (res.warn) out.appendChild(h('p', 'test-tip', res.warn));
        };
        if (res.url) done(res.url);
        else media.url(res.mediaId).then(done);
        ctx.toast('画好了，已收进图库', 'ok');
      });
    });

    /* 「本次生成参数」回显：只用点击瞬间那份快照（snap），**不是**回调里再读 DOM。
       几项就够对账 —— 模式 / 主体 / 镜头 / 手部 / 视觉层版本；
       不显示密钥、不显示完整 prompt、不做全局遥测。 */
    function paramLine(snap) {
      /* 临时双人：镜头固定「按画面描述」，不列被隐藏的单人镜头 / hands 选择；
         系统手部附加词本轮是关闭态（debug.handsVersion=off）。 */
      /* 临时多人（群像）：镜头／手部不使用单人下拉，回显按施工单口径写死
         「多人临时测试 · 镜头按画面描述 · 系统手部附加词关闭」 */
      if (snap.group) {
        return h('p', 'test-tip', '本次生成参数：模式 ' + snap.mode
          + ' · 主体 多人（临时测试，不读取群岛资料）'
          + ' · 人数 ' + ((snap.personCount || 0) + ' 人')
          + ' · 接口 ' + (snap.apiKind || '(当前)')
          + ' · 通道 ' + twoChannelLabel(snap.apiKind)
          + ' · 镜头 按画面描述'
          + ' · 系统手部附加词 关闭'
          + ' · 视觉层 自定义视觉词 ' + (snap.custom || '(空)'));
      }
      if (snap.two) {
        return h('p', 'test-tip', '本次生成参数：模式 ' + snap.mode
          + ' · 主体 双人（临时测试，不读取角色资料）'
          + ' · 接口 ' + (snap.apiKind || '(当前)')
          + ' · 通道 ' + twoChannelLabel(snap.apiKind)
          + ' · 镜头 按画面描述'
          + ' · 系统手部附加词 关闭'
          + ' · 视觉层 自定义视觉词 ' + (snap.custom || '(空)'));
      }
      var subj = '无人场景／物品';
      if (snap.temp) {
        subj = '单人（临时测试）' + (snap.gender === 'male' ? '·男'
          : snap.gender === 'female' ? '·女' : '·性别不指定');
      } else if (snap.ref) {
        subj = '已有角色／马甲';
      }
      var handsLabel = snap.hands === 'visible' ? '手明确可见'
        : snap.hands === 'hidden' ? '手明确不入镜' : '未指定（不追加手部词）';
      var layerLabel = snap.layer === 'temp-male-v2' ? '男性默认底座（v2）'
        : snap.layer === 'temp-female-c' ? '女性定稿底座（C 版）'
        : snap.layer === 'sleepy-default' ? 'Sleepy 单人默认底座'
        : snap.layer === 'custom' ? '自定义视觉词' : 'legacy（旧路径）';
      /* 手部词版本（2026-10-01 定点返修后只剩两态，与空串行为一致）：
         off=系统附加手部段关闭（hands=visible 时也一样不追加，各分支一视同仁）
         ；其余一律「未加手部词」。
         ⚠️ 这里只说「系统有没有追加手部词」，**与 hands 的选择并列展示** ——
         「手部 手明确可见」仍是你选的原值，不许把 visible 改写成 hidden/unspecified。 */
      var handsVerLabel = snap.handsVer === 'off' ? '手部附加词：关闭' : '未加手部词';
      /* 「手部选择（仅记录）<原值>」：hands 只记录，不独立产生要求；
         系统附加段仍显示关闭（handsVerLabel 由 debug.handsVersion 驱动）。 */
      return h('p', 'test-tip', '本次生成参数：模式 ' + snap.mode + ' · 主体 ' + subj
        + ' · 镜头 ' + shotLabel(snap.shot) + ' · 手部选择（仅记录）' + handsLabel
        + ' · 视觉层 ' + layerLabel + ' · 手部词 ' + handsVerLabel);
    }
    /* 双人这条路的发送通道：general = 独立 negative_prompt 字段；
       chat（文字通道）= positive + 负面拼成自然语言正文送到 /chat/completions。
       只写**代码实际怎么发**，不声称模型侧认不认（那要真图/真接口才知道）。 */
    function twoChannelLabel(kind) {
      if (kind === 'chat') return '文字通道（自然语言正文）';
      if (kind === 'nai') return 'NAI';
      return '常规生图（独立 negative 字段）';
    }
    function shotLabel(v) {
      var map = { auto: '不指定', selfie: '自拍／近距离', portrait: '半身／肖像',
        full: '全身', candid: '生活抓拍' };
      return map[v] || v;
    }

    /* 复制：navigator.clipboard 优先，file:// 下没有就退回 execCommand。
       都失败就把内容弹出来让人手选 —— 反正不能让他复制不到。 */
    function copyText(text, btn) {
      var done = function () {
        ctx.toast('已复制', 'ok');
        if (btn) { btn.textContent = '复制好了'; setTimeout(function () { btn.textContent = '复制报错详情'; }, 1600); }
      };
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(text).then(done, function () { fallback(); });
        return;
      }
      fallback();
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) done();
          else ui.prompt({ title: '手动复制', value: text, note: '全选复制这段报错' });
        } catch (e) {
          ui.prompt({ title: '手动复制', value: text, note: '全选复制这段报错' });
        }
      }
    }

    var btnRow = h('div', 'btn-row');
    var saveBtn = button('保存', 'primary', function () { doSave(); });
    var delBtn = null;
    if (!isNew) {
      delBtn = button('删除', 'danger', function () { doDelete(); });
      btnRow.appendChild(delBtn);
    }
    btnRow.appendChild(saveBtn);
    body.appendChild(btnRow);

    ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

    function collect() {
      return {
        id: api.id,
        kind: api.kind,
        name: f.name.get(),
        baseUrl: f.baseUrl.get(),
        apiKey: f.apiKey.get(),
        model: f.model.get(),
        size: f.size.get() || '1024x1024',
        timeoutSec: Math.round(f.timeoutSec.get()) || 60,
        positivePreset: f.positivePreset.get(),
        negativePreset: f.negativePreset.get(),
        refSupport: f.refSupport ? f.refSupport.querySelector('select').value : 'none',
        enabled: f.enabled.get()
      };
    }

    function doSave() {
      var next = collect();
      if (!next.name) next.name = kindLabel;
      var list = imggen.listApis();
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === next.id) { idx = i; break; }
      if (idx >= 0) list[idx] = next; else list.push(next);
      var ok = imggen.saveApis(list);
      if (ok) {
        /* 「当前使用」落定：开了开关就用这套；关掉且原来是当前 → 让给第一套别的 */
        var actNow = imggen.activeApi();
        var wasCur = actNow && actNow.id === next.id;
        var wantCurrent = isNew ? true : !!(f.isCurrent && f.isCurrent.get());
        if (wantCurrent) {
          imggen.setCurrent(next.id);
        } else if (wasCur) {
          var other = '';
          for (var j = 0; j < list.length; j++) {
            if (list[j].id !== next.id && list[j].enabled !== false) { other = list[j].id; break; }
          }
          imggen.setCurrent(other);
        }
        ctx.toast(isNew ? '已保存并设为当前' : '已保存', 'ok');
        ctx.back();
      } else {
        ctx.toast((store.lastError() || {}).message || '保存失败', 'err');
      }
    }

    function doDelete() {
      ui.confirm({ title: '删掉「' + (api.name || '未命名') + '」？', ok: '删除', danger: true })
        .then(function (yes) {
          if (!yes) return;
          var wasCur = imggen.activeApi() && imggen.activeApi().id === api.id;
          var ok = imggen.saveApis(imggen.listApis().filter(function (x) { return x.id !== api.id; }));
          if (wasCur) imggen.setCurrent('');
          if (ok) { ctx.toast('已删除', 'ok'); ctx.back(); }
          else ctx.toast('删除失败', 'err');
        });
    }
  }

  Sleepy.register('settings-imggen-add', {
    title: '添加生图接口',
    render: function (ctx) {
      var kind = (ctx.params && ctx.params.kind) || 'general';
      renderForm(ctx, imggen.newApi(kind), true);
    }
  });

  Sleepy.register('settings-imggen-edit', {
    title: '编辑生图接口',
    render: function (ctx) {
      var id = ctx.params && ctx.params.id;
      var hit = null;
      imggen.listApis().forEach(function (p) { if (p.id === id) hit = p; });
      if (!hit) { ctx.toast('找不到这个接口', 'err'); ctx.back(); return; }
      renderForm(ctx, hit, false);
    }
  });

})(window);
