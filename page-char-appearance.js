/* ============================================================
   page-char-appearance.js — 角色聊天外观（线上模式 · 外观编辑页）

   按《角色设置 + 外观编辑 Demo v1》实现：
     预览（壁纸 + 气泡实时套用） / 三预设胶囊（默认·企微·捡手机） /
     壁纸（色板 + 上传 + 模糊/遮罩）/ 气泡形状（圆角 + 尾巴） /
     底纹 / 装饰 / 颜色（色板 + 氛围浓度）/ 排版（字号 + 间距）/
     CSS 高级自定义 / 应用范围（仅角色 · 全局）/ 恢复默认。

   数据：store 的 'charAppearance' = { global:{…}|null, byChar:{id:{…}} }。
   解析顺序：角色专属 > 全局默认 > 出厂默认（PRESETS.default）。

   应用：Sleepy.charAppearance.applyTo(pageCtx, chatId) ——
     生成一段以 .msg-wrap.ap-on 为作用域的 CSS 注入页面，
     聊天页渲染时调用。颜色用 color-mix 混默认底色，四个主题都不脏。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;
  var h = ui.h;

  /* ---------------------------- 出厂值 ---------------------------- */

  var COLORS = {
    mist:  { accent: '#708f88', soft: '#dce8e4', name: '雾青' },
    rose:  { accent: '#a77b81', soft: '#eadcdf', name: '旧玫瑰' },
    blue:  { accent: '#71859f', soft: '#dce3ec', name: '雨蓝' },
    amber: { accent: '#a18561', soft: '#e9e0d1', name: '茶金' },
    ink:   { accent: '#565d61', soft: '#dfe1e1', name: '墨灰' }
  };

  var TEXTURES = {
    none: 'none',
    grid: 'repeating-linear-gradient(0deg,transparent,transparent 7px,rgba(100,120,110,.1) 7px,rgba(100,120,110,.1) 8px),repeating-linear-gradient(90deg,transparent,transparent 7px,rgba(100,120,110,.1) 7px,rgba(100,120,110,.1) 8px)',
    dot: 'radial-gradient(circle,rgba(100,120,110,.22) 1px,transparent 1.5px) 0 0 / 8px 8px',
    paper: 'repeating-linear-gradient(90deg,rgba(100,120,110,.04) 0,rgba(100,120,110,.04) 1px,transparent 1px,transparent 4px)'
  };

  var DECOS = {
    none: { outline: 'none', shadow: 'none' },
    soft: { outline: '1px solid rgba(100,160,140,.3)', shadow: 'none' },
    dash: { outline: '1.5px dashed rgba(100,160,140,.45)', shadow: 'none' },
    glow: { outline: 'none', shadow: 'inset 0 0 10px rgba(100,160,140,.25), 0 0 8px rgba(100,160,140,.15)' }
  };

  var PRESETS = {
    default: { mode: 'classic', color: 'mist', bgColor: 'none', bubbleR: 16, tail: 'bottom', tex: 'none', deco: 'none', fontSize: 100, msgGap: 14, wash: 80, bgBlur: 0, bgDim: 0 },
    wecom:   { mode: 'wecom',   color: 'mist', bgColor: '#ededee', bubbleR: 10, tail: 'top',    tex: 'none', deco: 'none', fontSize: 97,  msgGap: 10, wash: 80, bgBlur: 0, bgDim: 0 },
    phone:   { mode: 'phone',   color: 'mist', bgColor: '#b9c0cb', bubbleR: 6,  tail: 'top',    tex: 'none', deco: 'none', fontSize: 100, msgGap: 12, wash: 80, bgBlur: 0, bgDim: 0 }
  };

  /* 企微 / 捡手机是整套皮肤（参考截图逐色）：
     颜色、底纹、装饰、氛围浓度不参与；壁纸 / 圆角 / 间距 / 字号仍可用。 */
  var SKINS = {
    wecom: { bg: '#ededee', incoming: '#ffffff', outgoing: '#b7dcf8', ink: '#191919', time: '#979a9e',
             input: '#f7f7f7', field: '#ffffff', btn: '#b7dcf8' },
    phone: { bg: '#b9c0cb', incoming: '#ffffff', outgoing: '#fbe96c', ink: '#1a1a1a', time: '#83888f',
             input: '#f2f3f5', field: '#ffffff', btn: '#fbe96c' }
  };

  function blank() {
    var o = {};
    Object.keys(PRESETS.default).forEach(function (k) { o[k] = PRESETS.default[k]; });
    o.bgImage = null;         /* media 库里的壁纸 id */
    o.customCss = '';
    o.preset = 'default';
    return o;
  }

  function isSkin(cfg) { return !!SKINS[cfg.mode]; }

  /* 气泡底色 → 字色。色板是**角色级**的选择（角色外观里挑的），
     底色换了字色必须跟着翻：浅色板配白字就是一片看不见。
     用相对亮度判明暗，白 / 近黑二选一 —— 各家聊天都是这个做法。
     注意作用面只到「我方气泡」：对方气泡跟主题（.msg-assistant 走 --g-ink），
     这是用户 2026-09-21 拍的口径「正文跟着主题，气泡有角色设置的话跟着角色设置」。 */
  function inkOn(hex) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return '#FFFFFF';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    /* sRGB 相对亮度（WCAG 那条公式，系数取整到 0.001 就够用） */
    var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.62 ? '#241F19' : '#FFFFFF';
  }

  /* ---------------------------- 存取 ---------------------------- */

  function readAll() {
    return store.get('charAppearance') || { global: null, byChar: {} };
  }
  function writeAll(all) { store.set('charAppearance', all); }

  /* 角色专属 > 全局 > 出厂 */
  function resolve(charId) {
    var all = readAll();
    var saved = (charId && all.byChar && all.byChar[charId]) || all.global || null;
    var cfg = blank();
    if (saved) Object.keys(cfg).forEach(function (k) {
      if (saved[k] !== undefined) cfg[k] = saved[k];
    });
    cfg.__scope = (saved && saved.__scope) || (all.global && !saved ? 'global' : 'char');
    return cfg;
  }

  function persist(charId, cfg) {
    var all = readAll();
    var clean = {};
    Object.keys(cfg).forEach(function (k) { if (k.indexOf('__') !== 0) clean[k] = cfg[k]; });
    if (cfg.__scope === 'global') {
      all.global = clean;
      /* 全局化时把角色专属那份收掉，免得永远压着全局 */
      if (charId && all.byChar) delete all.byChar[charId];
    } else {
      all.byChar = all.byChar || {};
      all.byChar[charId] = clean;
    }
    writeAll(all);
  }

  function clearChar(charId) {
    var all = readAll();
    if (all.byChar) delete all.byChar[charId];
    writeAll(all);
  }

  /* ---------------------------- 生成 CSS ----------------------------
     值全部烤进字符串，作用域 .msg-wrap.ap-on —— 聊天页给消息容器
     加上这个类就生效，不用碰主题变量，四个主题都不会脏。 */

  function buildCss(cfg, bgUrl) {
    var c = COLORS[cfg.color] || COLORS.mist;
    var r = cfg.bubbleR;
    var skin = SKINS[cfg.mode] || null;
    var uBg = 'color-mix(in srgb, ' + c.accent + ' ' + cfg.wash + '%, var(--amber))';
    var lines = [];

    /* 消息容器：间距 / 背景 */
    var bg = 'transparent';
    if (cfg.bgImage && bgUrl) {
      bg = 'url("' + bgUrl + '") center / cover no-repeat';
    } else if (cfg.bgColor === 'night') {
      bg = 'linear-gradient(135deg,#1a1f2e,#2a2040)';
    } else if (cfg.bgColor && cfg.bgColor !== 'none') {
      bg = cfg.bgColor;
    } else if (skin) {
      bg = skin.bg;           /* 皮肤自带底色（预设里也写了，双保险） */
    }
    if (cfg.bgDim > 0 && bg !== 'transparent') {
      bg = 'linear-gradient(rgba(0,0,0,' + (cfg.bgDim / 100).toFixed(2) + '),rgba(0,0,0,' + (cfg.bgDim / 100).toFixed(2) + ')),' + bg;
    }
    lines.push('.msg-wrap.ap-on{gap:' + cfg.msgGap + 'px;background:' + bg + ';}');
    lines.push('.msg-wrap.ap-on .msg-text{font-size:calc(14px * ' + (cfg.fontSize / 100) + ');}');

    /* 图片壁纸才有模糊层（纯色没有可糊的东西） */
    if (cfg.bgImage && bgUrl && cfg.bgBlur > 0) {
      lines.push('.msg-wrap.ap-on.ap-bgimg{position:relative;}');
      lines.push('.msg-wrap.ap-on.ap-bgimg::before{content:"";position:absolute;inset:0;background:url("' + bgUrl +
        '") center / cover no-repeat;filter:blur(' + cfg.bgBlur + 'px);z-index:0;pointer-events:none;}');
      lines.push('.msg-wrap.ap-on.ap-bgimg > *{position:relative;z-index:1;}');
    }

    /* 尾巴位置 → 圆角方向 + 三角形开关 */
    var tex = skin ? 'none' : (TEXTURES[cfg.tex] || 'none');
    var deco = skin ? DECOS.none : (DECOS[cfg.deco] || DECOS.none);
    if (cfg.tail === 'none') {
      lines.push('.msg-wrap.ap-on .msg-text{border-radius:' + r + 'px !important;}');
      lines.push('.msg-wrap.ap-on .msg-text::after{display:none;}');
    } else if (cfg.tail === 'bottom') {
      lines.push('.msg-wrap.ap-on .msg-assistant .msg-text{border-radius:' + r + 'px ' + r + 'px ' + r + 'px 3px;}');
      lines.push('.msg-wrap.ap-on .msg-user .msg-text{border-radius:' + r + 'px ' + r + 'px 3px ' + r + 'px;}');
      lines.push('.msg-wrap.ap-on .msg-assistant .msg-text::after{top:auto;bottom:0;}');
      lines.push('.msg-wrap.ap-on .msg-user .msg-text::after{top:auto;bottom:0;}');
    } else { /* top —— 现在的样子 */
      lines.push('.msg-wrap.ap-on .msg-assistant .msg-text{border-radius:3px ' + r + 'px ' + r + 'px ' + r + 'px;}');
      lines.push('.msg-wrap.ap-on .msg-user .msg-text{border-radius:' + r + 'px 3px ' + r + 'px ' + r + 'px;}');
    }

    lines.push('.msg-wrap.ap-on .msg-text{background-image:' + tex + ';outline:' + deco.outline + ';box-shadow:' + deco.shadow + ';}');

    if (skin) {
      /* ---- 企微 / 捡手机：整套皮肤，气泡颜色不跟色板走 ---- */
      lines.push('.msg-wrap.ap-on .msg-assistant .msg-text{background-color:' + skin.incoming + ';color:' + skin.ink + ';}');
      lines.push('.msg-wrap.ap-on .msg-assistant .msg-text::after{border-right-color:' + skin.incoming + ';}');
      lines.push('.msg-wrap.ap-on .msg-user .msg-text{background-color:' + skin.outgoing + ';color:' + skin.ink + ';}');
      lines.push('.msg-wrap.ap-on .msg-user .msg-text::after{border-left-color:' + skin.outgoing + ';}');
      lines.push('.msg-wrap.ap-on .msg-time{color:' + skin.time + ';}');
      /* 头像：皮肤里都是方圆角（参考图）；捡手机没有 user 头像 */
      lines.push('.msg-wrap.ap-on.mode-wecom .msg-avatar,.msg-wrap.ap-on.mode-phone .msg-avatar{border-radius:8px;}');
      lines.push('.msg-wrap.ap-on.mode-phone .msg-user .msg-avatar{display:none;}');
      /* 输入区跟着换皮（功能不变，只是颜色） */
      lines.push('.page.ap-accented .input-area{background:' + skin.input + ';}');
      lines.push('.page.ap-accented .chat-input{background:' + skin.field + ';border-color:transparent;}');
      lines.push('.page.ap-accented .chat-input:focus{border-color:' + skin.outgoing + ';}');
      lines.push('.page.ap-accented .send-btn{background:' + skin.btn + ';color:#fff;}');
      lines.push('.page.ap-accented .send-btn.is-busy{background:#c9cdd2;color:#fff;}');
    } else {
      /* ---- 经典：主题色 × 氛围浓度；尾巴三角跟着同色 ---- */
      lines.push('.msg-wrap.ap-on .msg-user .msg-text{background-color:' + uBg + ';}');
      lines.push('.msg-wrap.ap-on .msg-user .msg-text::after{border-left-color:' + uBg + ';}');
      /* 我方气泡的字色跟着**这张色板**翻（见 inkOn 的说明）。
         不给对方气泡写字色 —— 它跟主题走。 */
      var uInk = inkOn(c.accent);
      lines.push('.msg-wrap.ap-on .msg-user .msg-text,.msg-wrap.ap-on .msg-user .msg-body{color:' + uInk + ';}');
    }

    return lines.join('\n');
  }

  /* 输入区不在 .msg-wrap 里，单独给聊天页根上一个色变量类 */
  function buildPageCss(cfg) {
    var c = COLORS[cfg.color] || COLORS.mist;
    return '.page.ap-accented .send-btn{background:' + c.accent + ';color:#fff;}' +
           '.page.ap-accented .chat-input:focus{border-color:' + c.accent + ';}';
  }

  /* ---------------------------- 应用到聊天页 ----------------------------
     幂等：页面重建（rebuild）后重调即可。customCss 独立管理。 */

  function applyTo(pageCtx, chatId) {
    var chat = Sleepy.chatStore && Sleepy.chatStore.getChat(chatId);
    var charId = chat && chat.characterId;
    var cfg = resolve(charId);

    var wrap = pageCtx.el.querySelector('.msg-wrap');
    if (wrap) {
      var old = document.getElementById('apStyleCur');
      if (old) old.parentNode.removeChild(old);
      if (cfg) {
        var useBg = null;
        if (cfg.bgImage && Sleepy.media) {
          Sleepy.media.url(cfg.bgImage).then(function (u) {
            /* 异步拿到地址后重刷一次（同步路径先用纯色兜着） */
            applyTo(pageCtx, chatId);
          });
        } else {
          useBg = null;
        }
        var st = document.createElement('style');
        st.id = 'apStyleCur';
        st.textContent = buildCss(cfg, useBg) + (isSkin(cfg) ? '' : ('\n' + buildPageCss(cfg)));
        document.head.appendChild(st);
        wrap.classList.remove('mode-classic', 'mode-wecom', 'mode-phone');
        wrap.classList.add('ap-on', 'mode-' + (cfg.mode || 'classic'));
        if (cfg.bgImage) wrap.classList.add('ap-bgimg');
        pageCtx.el.classList.add('ap-accented');
      }
    }
    /* 高级自定义 CSS：作用域是整个聊天页（demo 说明如此） */
    var custom = document.getElementById('apCustomStyle');
    if (custom && custom.parentNode) custom.parentNode.removeChild(custom);
    if (cfg && cfg.customCss && cfg.customCss.trim()) {
      custom = document.createElement('style');
      custom.id = 'apCustomStyle';
      custom.textContent = '/* 角色外观 · CSS 高级自定义 */\n' + cfg.customCss;
      document.head.appendChild(custom);
    }
  }

  /* ---------------------------- 页面 ----------------------------
     render 提到模块层 —— 「恢复默认」要整页重建（同参重开壳子不重渲染），
     直接 re-run 本函数即可，不能借 Sleepy.register 反查（单参会把注册表洗掉）。 */
  function renderAppearance(ctx) {
      var body = ctx.body;
      var chatId = ctx.params.chatId || '';
      var chat = Sleepy.chatStore && Sleepy.chatStore.getChat(chatId);
      var charId = chat && chat.characterId;
      var char = charId && Sleepy.core.findChar(charId);

      var cfg = resolve(charId);
      var bgObjectUrl = null;      /* 预览用 */

      body.innerHTML = '';

      /* ---- 预览 ---- */
      var preview = h('div', 'cap-preview');
      var pvBg = h('div', 'cap-pv-bg');
      var pvInner = h('div', 'cap-pv-inner');
      var rowIn = h('div', 'cap-pv-row');
      var ava = h('div', 'cap-pv-ava');
      var bIn = h('div', 'cap-pv-bubble', '今晚过得怎么样？');
      rowIn.appendChild(ava); rowIn.appendChild(bIn);
      var rowOut = h('div', 'cap-pv-row is-out');
      var bOut = h('div', 'cap-pv-bubble', '刚刚好，也有一点想你。');
      rowOut.appendChild(bOut);
      pvInner.appendChild(rowIn); pvInner.appendChild(rowOut);
      var pvStyle = document.createElement('style');
      preview.appendChild(pvBg); preview.appendChild(pvInner); preview.appendChild(pvStyle);
      body.appendChild(preview);

      /* ---- 预设胶囊 ---- */
      var presetRow = h('div', 'cap-presets');
      var presetBtns = {};
      [['default', '默认'], ['wecom', '企微'], ['phone', '捡手机']].forEach(function (p) {
        var b = h('button', 'cap-preset' + (cfg.preset === p[0] ? ' active' : ''), p[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          Object.keys(PRESETS[p[0]]).forEach(function (k) { cfg[k] = PRESETS[p[0]][k]; });
          cfg.preset = p[0];
          cfg.customCss = cfg.customCss;   /* 高级 CSS 不被预设洗掉 */
          Object.keys(presetBtns).forEach(function (k) { presetBtns[k].classList.toggle('active', k === p[0]); });
          refresh();
        });
        presetBtns[p[0]] = b;
        presetRow.appendChild(b);
      });
      body.appendChild(presetRow);

      /* 皮肤模式提示（企微 / 捡手机时说明哪些项不参与） */
      var hintEl = h('p', 'cap-mode-hint', '');
      body.appendChild(hintEl);

      /* ---- 编辑区 ---- */
      var editor = h('div', 'cap-editor');
      body.appendChild(editor);

      function groupEl(title) {
        var g = h('div', 'cap-group');
        g.appendChild(h('p', 'cap-group-title', title));
        editor.appendChild(g);
        return g;
      }
      function slider(g, label, min, max, key, onChange) {
        var row = h('div', 'cap-ctrl');
        row.appendChild(h('label', '', label));
        var input = h('input');
        input.type = 'range'; input.min = min; input.max = max; input.value = cfg[key];
        var out = h('output', '', String(cfg[key]));
        input.addEventListener('input', function () {
          cfg[key] = +input.value;
          out.textContent = input.value;
          onChange && onChange();
          refresh();
        });
        row.appendChild(input); row.appendChild(out);
        g.appendChild(row);
        return input;
      }
      function chipRow(g, label, options, key, hasLabel) {
        if (label) g.appendChild(h('p', 'cap-group-title cap-sub', label));
        var chips = h('div', 'cap-chips');
        options.forEach(function (o) {
          var b = h('button', 'cap-chip' + (cfg[key] === o.value ? ' active' : ''), o.label);
          b.type = 'button';
          b.addEventListener('click', function () {
            cfg[key] = o.value;
            [].forEach.call(chips.children, function (x) { x.classList.remove('active'); });
            b.classList.add('active');
            refresh();
          });
          chips.appendChild(b);
        });
        g.appendChild(chips);
        return chips;
      }

      /* 壁纸 */
      var gWp = groupEl('壁纸');
      var wpRow = h('div', 'cap-wp-row');
      var wpBtns = {};
      [
        { v: 'none', css: '#eef0ec', name: '默认' },
        { v: '#e0e6ed', css: '#e0e6ed' },
        { v: '#f0e8e4', css: '#f0e8e4' },
        { v: '#e8eae0', css: '#e8eae0' },
        { v: 'night', css: 'linear-gradient(135deg,#1a1f2e,#2a2040)' }
      ].forEach(function (o) {
        var b = h('button', 'cap-wp' + (cfg.bgColor === o.v && !cfg.bgImage ? ' active' : ''));
        b.type = 'button';
        b.style.background = o.css;
        if (o.name) b.title = o.name;
        b.addEventListener('click', function () {
          cfg.bgColor = o.v; cfg.bgImage = null;
          markWp(o.v);
          refresh();
        });
        wpBtns[o.v] = b;
        wpRow.appendChild(b);
      });
      /* 上传 */
      var upload = h('button', 'cap-wp-upload', '+');
      upload.type = 'button';
      upload.title = '上传图片';
      var file = h('input');
      file.type = 'file'; file.accept = 'image/*'; file.style.display = 'none';
      upload.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f || !Sleepy.media) return;
        Sleepy.media.put(f, { kind: 'wallpaper', name: f.name }).then(function (mid) {
          cfg.bgImage = mid;
          markWp(null);
          refresh();
        });
      });
      wpRow.appendChild(upload);
      wpRow.appendChild(file);
      gWp.appendChild(wpRow);
      function markWp(v) {
        Object.keys(wpBtns).forEach(function (k) { wpBtns[k].classList.toggle('active', k === v && !cfg.bgImage); });
        upload.classList.toggle('active', !!cfg.bgImage);
      }
      slider(gWp, '背景模糊', 0, 20, 'bgBlur');
      slider(gWp, '遮罩深度', 0, 50, 'bgDim');

      /* 气泡形状 */
      var gShape = groupEl('气泡形状');
      slider(gShape, '圆角大小', 0, 24, 'bubbleR');
      chipRow(gShape, '尾巴位置', [
        { value: 'bottom', label: '底部' }, { value: 'top', label: '顶部' }, { value: 'none', label: '无尾巴' }
      ], 'tail');

      /* 底纹 */
      var gTex = groupEl('气泡底纹');
      (function () {
        var opts = h('div', 'cap-tex-row');
        [['none', '无'], ['grid', ''], ['dot', ''], ['paper', '']].forEach(function (o) {
          var b = h('button', 'cap-tex cap-tex-' + o[0] + (cfg.tex === o[0] ? ' active' : ''), o[1]);
          b.type = 'button';
          b.addEventListener('click', function () {
            if (isSkin(cfg)) { ctx.toast('先切回「默认」预设再调底纹', 'warn'); return; }
            cfg.tex = o[0];
            [].forEach.call(opts.children, function (x) { x.classList.remove('active'); });
            b.classList.add('active');
            refresh();
          });
          opts.appendChild(b);
        });
        gTex.appendChild(opts);
      })();

      /* 装饰 */
      var gDeco = groupEl('气泡装饰');
      chipRow(gDeco, '', [
        { value: 'none', label: '无' }, { value: 'soft', label: '柔边' },
        { value: 'dash', label: '虚线' }, { value: 'glow', label: '光晕' }
      ], 'deco');
      /* 皮肤模式下装饰不参与：点了只提示 */
      (function () {
        var wrap = gDeco.lastChild;
        [].forEach.call(wrap.querySelectorAll('.cap-chip'), function (b) {
          b.addEventListener('click', function () {
            if (isSkin(cfg)) ctx.toast('先切回「默认」预设再调装饰', 'warn');
          });
        });
      })();
      gDeco.lastChild.classList.add('cap-deco-row');

      /* 颜色 */
      var gColor = groupEl('颜色');
      var swRow = h('div', 'cap-swatches');
      var swBtns = {};
      Object.keys(COLORS).forEach(function (k) {
        var b = h('button', 'cap-swatch' + (cfg.color === k ? ' active' : ''));
        b.type = 'button';
        b.style.background = COLORS[k].accent;
        b.title = COLORS[k].name;
        b.addEventListener('click', function () {
          if (isSkin(cfg)) { ctx.toast('先切回「默认」预设再调颜色', 'warn'); return; }
          cfg.color = k; cfg.preset = 'custom';
          markSw(k);
          refresh();
        });
        swBtns[k] = b;
        swRow.appendChild(b);
      });
      function markSw(k) {
        Object.keys(swBtns).forEach(function (x) { swBtns[x].classList.toggle('active', x === k); });
      }
      gColor.appendChild(swRow);
      slider(gColor, '氛围浓度', 20, 100, 'wash');

      /* 排版 */
      var gType = groupEl('排版');
      slider(gType, '文字大小', 88, 114, 'fontSize');
      slider(gType, '气泡间距', 6, 22, 'msgGap');

      /* CSS 高级自定义 */
      var gCss = groupEl('CSS 高级自定义');
      var cssArea = h('textarea', 'cap-css-area');
      cssArea.placeholder = '/* 在这里写覆盖样式，作用域为聊天页 */\n.msg-text { font-style: italic; }';
      cssArea.value = cfg.customCss || '';
      cssArea.addEventListener('input', function () { cfg.customCss = cssArea.value; refresh(); });
      gCss.appendChild(cssArea);
      gCss.appendChild(h('p', 'cap-hint', '样式实时注入预览区 · 保存后作用于聊天页'));

      /* 应用范围 */
      var gScope = groupEl('应用范围');
      var scopeChips = h('div', 'cap-chips');
      [['char', '仅' + (char ? char.name : '该角色')], ['global', '设为全局默认']].forEach(function (o) {
        var b = h('button', 'cap-chip' + (cfg.__scope === o[0] ? ' active' : ''), o[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          cfg.__scope = o[0];
          [].forEach.call(scopeChips.children, function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          persist(charId, cfg);
          ctx.toast(o[0] === 'global' ? '已设为全局默认' : '仅对该角色生效', 'ok');
        });
        scopeChips.appendChild(b);
      });
      gScope.appendChild(scopeChips);

      /* 恢复默认 */
      var reset = h('button', 'cap-reset', '恢复默认外观');
      reset.type = 'button';
      reset.addEventListener('click', function () {
        cfg = resolve(charId);
        var fresh = blank();
        Object.keys(fresh).forEach(function (k) { cfg[k] = fresh[k]; });
        if (charId) clearChar(charId);
        ctx.rebuild && ctx.rebuild();
        ctx.toast('已恢复默认', 'ok');
      });
      body.appendChild(reset);

      /* ---- 预览刷新：所有改动都汇到这 ---- */
      function refresh() {
        var c = COLORS[cfg.color] || COLORS.mist;
        var skin = SKINS[cfg.mode] || null;
        /* 预览底 */
        if (cfg.bgImage) {
          if (bgObjectUrl) pvBg.style.backgroundImage = 'url("' + bgObjectUrl + '")';
          else if (Sleepy.media) Sleepy.media.url(cfg.bgImage).then(function (u) {
            bgObjectUrl = u;
            pvBg.style.backgroundImage = 'url("' + u + '")';
          });
        } else if (cfg.bgColor === 'night') {
          pvBg.style.backgroundImage = 'linear-gradient(135deg,#1a1f2e,#2a2040)';
        } else if (cfg.bgColor && cfg.bgColor !== 'none') {
          pvBg.style.backgroundImage = 'none';
          pvBg.style.backgroundColor = cfg.bgColor;
        } else {
          pvBg.style.backgroundImage = 'none';
          pvBg.style.backgroundColor = skin ? skin.bg : '#eef0ec';
        }
        pvBg.style.filter = cfg.bgBlur > 0 ? 'blur(' + cfg.bgBlur + 'px)' : '';
        pvBg.style.opacity = String(1 - cfg.bgDim / 100);

        /* 气泡 */
        var r = cfg.bubbleR;
        var uBg = skin ? skin.outgoing
                       : 'color-mix(in srgb, ' + c.accent + ' ' + cfg.wash + '%, #E8C87A)';
        var vBg = skin ? skin.incoming : '#ffffff';
        var ink = skin ? skin.ink : '#293330';
        bIn.style.borderRadius = (cfg.tail === 'bottom')
          ? r + 'px ' + r + 'px ' + r + 'px 3px'
          : (cfg.tail === 'top' ? '3px ' + r + 'px ' + r + 'px ' + r + 'px' : r + 'px');
        bOut.style.borderRadius = (cfg.tail === 'bottom')
          ? r + 'px ' + r + 'px 3px ' + r + 'px'
          : (cfg.tail === 'top' ? r + 'px 3px ' + r + 'px ' + r + 'px' : r + 'px');
        bIn.style.background = vBg; bIn.style.color = ink;
        bOut.style.background = uBg; bOut.style.color = ink;
        ava.style.borderRadius = skin ? '8px' : '50%';
        var tex = skin ? 'none' : (TEXTURES[cfg.tex] || 'none');
        bIn.style.backgroundImage = tex; bOut.style.backgroundImage = tex;
        var deco = skin ? DECOS.none : (DECOS[cfg.deco] || DECOS.none);
        bIn.style.outline = deco.outline; bIn.style.boxShadow = deco.shadow;
        bOut.style.outline = deco.outline; bOut.style.boxShadow = deco.shadow;
        pvInner.style.fontSize = (cfg.fontSize / 100) + 'em';
        pvInner.style.gap = (cfg.msgGap * 0.8) + 'px';

        /* 高级 CSS 只进预览 */
        pvStyle.textContent = cfg.customCss || '';

        /* 皮肤模式下的提示 */
        hintEl.textContent = skin
          ? ({ wecom: '企微', phone: '捡手机' }[cfg.mode]) + '是整套皮肤：颜色 / 底纹 / 装饰 / 氛围浓度不参与，壁纸 / 圆角 / 尾巴 / 间距 / 字号照常可用。'
          : '样式实时注入预览区 · 保存后作用于聊天页';

        persist(charId, cfg);
      }

      markWp(cfg.bgImage ? null : cfg.bgColor);
      markSw(cfg.color);
      refresh();

      ctx.rebuild = function () {
        /* 恢复默认后整页重建（同参重开壳子不会重渲染） */
        renderAppearance(ctx);
      };
  }

  Sleepy.register('char-appearance', {
    title: '外观',
    render: renderAppearance
  });

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.charAppearance = {
    resolve: resolve,
    applyTo: applyTo,
    COLORS: COLORS
  };

})(window);
