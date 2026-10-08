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
         只有两档；内置词不提供编辑（§一）。切换不清空自定义原文；
         自定义框只在 custom 档露面。独立字段，与实验区的 visualExp* 互不混用。
         2026-10-07 用户：组内说明文字全去掉（自定义框 hint / 动态提示 / NAI 段），
         只留组标题、视觉层下拉、自定义框。功能与显隐逻辑未动。 */
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
        rows: 3,
        value: imggen.imgStyleCustom(),
        placeholder: '例：flat graphic illustration, limited 6-color palette'
      });
      gs.card.appendChild(styleCustom.el);
      /* 2026-10-07 用户：视觉层这一组的说明文字（自定义框 hint、随档位变的动态
         提示、NAI 那段）全部去掉 —— 字段本身与显隐逻辑一字未动。
         NAI 沿用原生图路径、本组视觉层对 NAI 不生效，仍是事实，只是不再显示。 */
      function syncStyleUI() {
        styleCustom.el.style.display = styleSel.value === 'custom' ? '' : 'none';
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

    /* ---------- 预设词（想覆盖再填；内置词不展示，2026-10-08 用户拍板） ----------
       「不要把我们的提示词放出来」：老存档预灌过、和内置一字不差的，
       显示为空（＝用内置）；真改过的显示他改的原文。留空保存也合法 ——
       运行时空串回落内置（三条路同款回落），拼出来的词分毫不变。 */
    var bpBase = imggen.BUILTIN_PRESET[api.kind] || imggen.BUILTIN_PRESET.general;
    var g2 = group('预设词',
      '留空＝用内置起手式（内置词不在这里展示）。想整体换掉再填，{p} 是「这回画什么」的位置。');
    f.positivePreset = textArea({
      label: '正面预设', rows: 2,
      value: (api.positivePreset && api.positivePreset !== bpBase.positive)
        ? api.positivePreset : '',
      hint: '{p} = 锁脸 + 这次的内容 + 勾的词条'
    });
    g2.card.appendChild(f.positivePreset.el);
    f.negativePreset = textArea({
      label: '负面预设（不想要什么）', rows: 2,
      value: (api.negativePreset && api.negativePreset !== bpBase.negative)
        ? api.negativePreset : ''
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

    /* ---- 主体 / 镜头（正式管线，2026-10-08 用户拍板）----
       试一张与聊天发图走**同一条正式拼接器**（generate({plan})）：
       视觉层跟随「视觉层（正式生图）」的内置/自定义设置，不再有
       legacy 对照、E1/E2 实验措辞或内置词展示。实验拼接器本体保留在
       imggen.js（冒烟在用），只是不再提供 UI 入口。
       主体从**本岛名册**挑（角色 / 我的马甲，读 B1 的 subjectForChar /
       subjectForUser，联调锁脸）；小号/皮套/NPC 不给选项（B0 的 subjects
       只认 user/char 两种 entityType）。 */
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

    /* 两类主体：无人场景（直接走 01 场景底座）+ 本岛名册的真实身份。 */
    var realIdentities = [];
    var sb = core.activeSandbox();
    core.charsOfSandbox(sb).forEach(function (c) {
      realIdentities.push(['char:' + c.id, '角色 · ' + (c.name || '未命名')]);
    });
    core.masksOfSandbox(sb).forEach(function (u) {
      realIdentities.push(['user:' + u.id, '我 · ' + (core.labelOfUser(u) || '我')]);
    });
    var subjOptions = [
      ['', '无人场景／物品']
    ];
    if (realIdentities.length) {
      subjOptions.push({ group: '已有角色／马甲（锁脸联调）', items: realIdentities });
    }

    /* 只有**本岛名册里**的 ref 才算有效。岛间隔绝不放松：
       这里**不**退化成「读全部角色」。 */
    var allowedRefs = {};
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

    /* 名册为空时**明确说一句**，别让人对着空下拉猜。绝不靠「读全部角色」来填满下拉。 */
    if (!realIdentities.length) {
      tryFold.body.appendChild(h('p', 'test-tip',
        '现在没有可选的角色／马甲（本岛名册为空）。想联调锁脸，先去建人并把他加进当前岛；'
        + '想先试接口，用「无人场景／物品」就行。'));
    }

    var shotPick = expSelect('镜头', [
      ['auto', '不指定'],
      ['selfie', '自拍／近距离'],
      ['portrait', '半身／肖像'],
      ['full', '全身'],
      ['candid', '生活抓拍']
    ], imggen.singleExpShot(), function (v) { imggen.setSingleExpShot(v); });
    tryFold.body.appendChild(shotPick.el);

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

      /* 正式管线（2026-10-08 用户拍板）：与聊天发图同一条 generate({plan}) ——
         视觉层跟随「视觉层（正式生图）」的内置/自定义设置，锁脸/校验/报错
         语义全同款。提示词库词条照旧拼上（正式路吃 extras，与 legacy 一致）。 */
      var extras = imggen.listPrompts().map(function (p) { return p.text; });
      var ref = subjPick.sel.value;
      var shot = shotPick.sel.value;
      var subjects = [];
      if (ref) {
        var one = subjectForRef(ref, shot);
        /* 主体查不到（切岛 / 被删）：**拦下来让人重选** ——
           不静默换成别人，也不回落成「没有人」的无人图。 */
        if (!one) {
          genBtn.disabled = false;
          out.className = 'imggen-out is-err';
          out.innerHTML = '';
          out.appendChild(h('p', 'test-title', '这个主体已经不在本岛或已被删除'));
          out.appendChild(h('p', 'test-tip', '重新在「主体」里选一个再生成。'));
          return;
        }
        subjects.push(one);
      }
      /* **点击瞬间**就把这次的参数快照下来（不靠异步回调里再读可变 DOM）——
         回显的「本次生成参数」与实际请求用的是同一份值。不含任何密钥。 */
      var snap = {
        ref: ref,
        hasSubject: subjects.length > 0,
        shot: shot,
        apiKind: (imggen.activeApi() || {}).kind || ''
      };
      var req = imggen.generate({
        api: collect(),
        plan: {
          contentType: subjects.length ? 'person' : 'scene',
          shot: shot,
          subjects: subjects,
          description: subject
        },
        extras: extras
      });

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
       几项就够对账 —— 主体 / 镜头 / 视觉层 / 接口类型；
       不显示密钥、不显示完整 prompt、不做全局遥测。 */
    function paramLine(snap) {
      var subjLabel = snap.hasSubject ? '已有角色／马甲（锁脸联调）' : '无人场景／物品';
      var kindLabel = ((imggen.KINDS[snap.apiKind] || {}).label) || snap.apiKind || '(当前)';
      return h('p', 'test-tip', '本次生成参数：正式管线'
        + ' · 主体 ' + subjLabel
        + ' · 镜头 ' + shotLabel(snap.shot)
        + ' · 视觉层 ' + (imggen.imgStyleMode() === 'custom' ? '自定义视觉词' : '内置（已核准底座）')
        + ' · 接口类型 ' + kindLabel);
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
