/* ============================================================
   legal.js — 用户协议 / 隐私政策（内测前，2026-10-07 发售路线 v1 第 1 件）

   为什么要有这个文件：
     内测要对外，就不能没有协议。它同时是**承诺**：我们本地优先、
     数据在用户自己设备上 —— 这话写在纸上才是卖点，光在嘴上说没用。

   职责（三件事，都很小）：
     ① 正文常量：USER_AGREEMENT / PRIVACY_POLICY（纯文本数组，渲染时转 DOM）
     ② 首启弹窗：第一次打开时弹一次，下面两个按钮
          · 「我已知情，不再提示」→ 记标记，以后不再弹（推荐项，放左边当默认焦点）
          · 「先看看」→ 不记标记，下次进来还会弹（别强迫，留后悔的余地）
     ③ 随时可再打开：设置里留一个入口，用户想看还能翻出来。

   ⚠️ 关键设计：**正文里的每一条都必须是真的**。
     尤其「不上传」这句 —— 我们有 GitHub 备份这个可选功能（数据在用户自己仓里），
     所以措辞不能写成「我们从不接触你的数据」，要写成
     「默认全部数据留在你自己的设备上；只有你自己主动开启备份时，
      数据才会离开设备，且由你选择存在哪里」。这句经得起追问。

   存储：只存一个「已同意」标记（app:legal），**不存任何身份信息**。
   依赖：ui.js（h/ 按钮）、store.js、app.js（Sleepy.bootHome 时机）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var store = Sleepy.store;

  var h = ui.h;

  /* 同意标记的存储键。**不进用户存档导出** —— 它是这台设备的 UI 状态，
     不是用户数据的一部分（store.isProcessKey 那套口径之外的另一类：
     「本地偏好」，跟着设备走，不跟着账号走）。 */
  var AGREE_KEY = 'legalAgreedAt';
  var AGREE_VER = 'v1';        /* 协议版本：改协议正文就+1，老用户会重新看到一次 */

  /* ---------------- 正文 ---------------- */

  var USER_AGREEMENT = {
    title: '用户协议',
    updated: '2026-10-07',
    sections: [
      { h: '一、这个软件是什么', p: [
        '小手机（Sleepy）是一个**本地运行的虚拟手机应用**，用来和你自己创建的、或你导入的角色进行对话与互动。',
        '它不是社交软件，不提供任何真人交友、真人语音或真人视频功能。软件里的一切角色、对话、动态都是**程序生成的内容**，不是真人。'
      ] },
      { h: '二、你要自己准备什么', p: [
        '软件不自带任何 AI 模型，也不提供免费额度。**自行准备**，并自行承担该接口产生的全部费用。',
        '软件作者不参与、不垫付、不担保你的接口费用，也不对接口服务方的行为承担责任。'
      ] },
      { h: '三、你的数据在你自己手里', p: [
        '默认情况下，你的**全部留在你自己的设备上**，不会上传到我们的服务器。',
        '我们无法读取、也无法恢复你设备上的数据。请你**定期导出**自行备份 —— 清理浏览器数据、更换设备、卸载重装都会导致数据丢失，且我们无法帮你找回。'
      ] },
      { h: '四、可用性', p: [
        '这是一个内测版本，功能可能随时调整、可能出现故障。我们会尽力修复，但不保证任何功能始终可用。',
        '内测期间的部分功能可能需要你自行配置（包括但不限于AI 接口配置）。'
      ] },
      { h: '五、禁止用途', p: [
        '不得使用本软件从事任何违法违规活动，包括但不限于：制作、传播违法内容；侵犯他人合法权益；攻击、破坏服务器或他人系统。',
        '软件内的角色设定与对话内容由使用者自行创建和生成，**使用者需自行判断和承担相应责任**。'
      ] },
      { h: '六、知识产权与免责', p: [
        '软件的程序部分著作权归作者所有。你导入的角色卡、世界书等内容**属于你自己或你有权使用的第三方内容**，请自行确保有权使用。',
        '本软件按「现状」提供，**按「现状」提供**。在任何情况下，作者不对因使用或无法使用本软件而产生的间接损失承担责任。'
      ] },
      { h: '七、协议变更', p: [
        '本协议可能随版本更新而修改。**协议版本变化时会再次提示你确认**，你继续使用即视为接受更新后的协议。'
      ] }
    ]
  };

  var PRIVACY_POLICY = {
    title: '隐私政策',
    updated: '2026-10-07',
    sections: [
      { h: '一、我们默认不收集你的任何数据', p: [
        '本软件是一个**本地优先**的应用。你的聊天记录、图片、语音、设置、账号信息，默认**全部保存在你自己的设备上**，我们既不收集、也不上传、更不存储。',
        '这意味着：如果你不主动使用任何需要联网的功能，我们不会因为使用本软件而获得你任何个人信息。'
      ] },
      { h: '二、什么情况下数据会离开你的设备', p: [
        '只有你**主动开启并使用**以下功能时，相应数据才会离开设备：',
        '· **AI 对话功能** —— 你输入的内容和角色卡内容会发送到你**自己配置的第三方 AI 接口**，由该服务方处理。这一条与你选择用哪家接口有关。',
        '· **云端备份功能（可选）** —— 如果你选择开启备份，数据会保存到**你自己选择的存储位置**（例如你自己的网盘或代码仓库账号）。我们不会替你保管。',
        '· **天气 / 实时信息** —— 该功能会请求公开的天气与新闻接口，但**不会附带你的任何身份信息**。'
      ] },
      { h: '三、我们可能会保存的信息', p: [
        '若你领取了激活码，我们会保存你的**QQ 号**，用途**仅限**激活与售后查询（如找回激活码）。我们不会用它做营销、不会分享给第三方。',
        '我们不会收集你的手机号、邮箱、通讯录、精确位置、相册（除非你主动选择某张图片用于游戏内使用）。'
      ] },
      { h: '四、本地存储的说明', p: [
        '软件会在你的浏览器本地保存数据（包括你的同意状态、设置偏好、聊天内容）。你可以随时通过软件内的「设置 → 数据与备份」清除这些数据。'
      ] },
      { h: '五、你的权利', p: [
        '你可以随时查看、更正、通过「设置 → 数据与备份 → 清除全部数据」删除你设备上的全部本地数据。',
        '若你希望删除我们持有的激活记录（你的 QQ 号），请通过领取激活码时使用的渠道（如群内）告知我们，我们会在合理期限内处理。'
      ] },
      { h: '六、未成年人保护', p: [
        '本软件的内容由使用者自行创建与生成，**使用者需自行判断内容是否适合未成年人**。',
        '若你是未成年人的监护人，请关注未成年人的使用情况，并对其接触的内容加以适当引导。'
      ] },
      { h: '七、政策更新', p: [
        '本政策可能随版本更新而修改。**政策版本变化时会再次提示你确认**。'
      ] }
    ]
  };

  /* ---------------- 同意标记 ---------------- */

  function agreedAt() {
    var v = store.get(AGREE_KEY);
    return v || null;
  }

  function isAgreed() {
    var v = agreedAt();
    return !!(v && v.ver === AGREE_VER);
  }

  /* 记同意。记的是**版本 + 时间**，不记身份信息。
     改 AGREE_VER → 老用户isAgreed() 变false →下次打开重新提示一次。 */
  function markAgreed() {
    store.set(AGREE_KEY, { ver: AGREE_VER, at: Date.now() });
  }

  function resetAgreed() {
    store.remove(AGREE_KEY);
  }

  /* ---------------- 渲染正文 ---------------- */

  /* 正文里用** 单引号做行内强调，渲染时换成<em>。
     不走 markdown 解析器 —— 就一个行内标记，值不起引依赖（零依赖是原则）。

     ⚠️ 强调片段必须**短**（一个词到四五个字）：真机看到长句加粗后，
     背景色被拆成好几段、跨行断开，像坏掉的排版（2026-10-07 真机验收才发现）。
     所以下面正文里的 ** 只包短词，不包整句。 */
  function richLine(text) {
    var out = [];
    /* 按 ** 切分，奇数段是强调部分 */
    var parts = String(text).split('**');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      out.push(i % 2 === 1 ? h('em', '', parts[i]) : document.createTextNode(parts[i]));
    }
    var frag = document.createDocumentFragment();
    /* ⚠️ 必须**逐个 append**，不能 `frag.appendChild.apply(frag, out)` ——
       DocumentFragment.appendChild 批量传数组时只有第一个进去，后面全静默丢。
       （真机查出来的：强调片段一条都没渲染，页面看着却「正常」——
         正文里的 ** 全成了普通文字，一处都不显眼。）
       项目里唯一稳的写法就是 ui.h 里那个 forEach，这里照抄。 */
    out.forEach(function (node) {
      if (node) frag.appendChild(node);
    });
    return frag;
  }

  function renderDoc(doc) {
    var wrap = h('div', 'legal-doc');
    wrap.appendChild(h('p', 'legal-doc-title', doc.title));
    wrap.appendChild(h('p', 'legal-doc-meta', '更新于 ' + doc.updated));
    for (var i = 0; i < doc.sections.length; i++) {
      var s = doc.sections[i];
      var sec = h('section', 'legal-sec');
      sec.appendChild(h('h3', '', s.h));
      for (var j = 0; j < s.p.length; j++) {
        var p = h('p', '', '');
        p.appendChild(richLine(s.p[j]));
        sec.appendChild(p);
      }
      wrap.appendChild(sec);
    }
    return wrap;
  }

  /* ---------------- 弹层 ----------------
     不用 ui.openDialog：它是输入框/确认框的骨架，装不下富文本 + 三按钮。
     但**复用它的类名与遮罩**（.dl-mask / .dl-card），这样视觉自动跟其余弹层一致，
     不用为协议再写一整套外观 —— 玻璃卡片那套（四件套 + :before）已经在那了。 */

  var layer = null;

  function ensureLayer() {
    if (layer) return layer;
    var host = document.getElementById('phone') || document.body;

    var mask = h('div', 'dl-mask legal-mask');
    var card = h('div', 'dl-card legal-card');

    var head = h('div', 'legal-head');
    var title = h('p', 'dl-title legal-title');
    var sub = h('p', 'legal-sub', '这是内测版，正式发布前请一定看完');
    head.appendChild(title);
    head.appendChild(sub);

    var tabs = h('div', 'legal-tabs');
    var bUser = h('button', 'legal-tab is-on', '用户协议');
    var bPriv = h('button', 'legal-tab', '隐私政策');
    bUser.type = 'button';
    bPriv.type = 'button';
    tabs.appendChild(bUser);
    tabs.appendChild(bPriv);

    var body = h('div', 'legal-body');

    var acts = h('div', 'legal-acts');
    var laterBtn = h('button', 'dl-btn', '先看看');
    var okBtn = h('button', 'dl-btn dl-btn-ok', '我已知情，不再提示');
    laterBtn.type = 'button';
    okBtn.type = 'button';
    acts.appendChild(laterBtn);
    acts.appendChild(okBtn);

    var foot = h('p', 'legal-foot',
      '本软件由你自己配置 AI 接口、内容由 AI 生成，请勿用于违法用途。');

    card.appendChild(head);
    card.appendChild(tabs);
    card.appendChild(body);
    card.appendChild(acts);
    card.appendChild(foot);
    mask.appendChild(card);
    host.appendChild(mask);

    function show(which) {
      body.innerHTML = '';
      body.appendChild(renderDoc(which === 'priv' ? PRIVACY_POLICY : USER_AGREEMENT));
      body.scrollTop = 0;
      bUser.classList[which === 'priv' ? 'remove' : 'add']('is-on');
      bPriv.classList[which === 'priv' ? 'add' : 'remove']('is-on');
    }

    bUser.addEventListener('click', function () { show('user'); });
    bPriv.addEventListener('click', function () { show('priv'); });
    show('user');

    layer = {
      mask: mask,
      card: card,
      title: title,
      show: show,
      open: function (opts) {
        opts = opts || {};
        title.textContent = opts.title || '开始之前';
        sub.textContent = opts.sub || '';
        sub.style.display = opts.sub ? '' : 'none';
        laterBtn.textContent = opts.laterText || '先看看';
        laterBtn.style.display = opts.noLater ? 'none' : '';
        okBtn.textContent = opts.okText || '我已知情，不再提示';
        foot.style.display = opts.foot === false ? 'none' : '';
        show(opts.tab === 'priv' ? 'priv' : 'user');
        mask.classList.add('is-open');
      },
      close: function () { mask.classList.remove('is-open'); }
    };

    laterBtn.addEventListener('click', function () { layer.close(); });
    okBtn.addEventListener('click', function () {
      markAgreed();
      layer.close();
      if (layer.onAgree) layer.onAgree();
    });
    /* 点遮罩 = 「先看看」—— 不诱导用户点同意（这条很重要，别做成逼用户勾选） */
    mask.addEventListener('click', function (e) {
      if (e.target === mask) layer.close();
    });

    return layer;
  }

  /* 首启弹窗。**只在用户还没同意过当前版本时弹**；
     「先看看」不写标记 —— 用户下次进来还会看到，这是有意留的余地。 */
  function maybeShowFirstRun() {
    if (isAgreed()) return false;
    ensureLayer().open({
      title: '开始之前',
      sub: '这是内测版。看完这两份就可以进去用了 —— 里面写着你的数据存在哪。',
      laterText: '先看看',
      okText: '我已知情，不再提示'
    });
    return true;
  }

  /* 设置里「随时再看」的入口。 */
  function openDoc(which) {
    ensureLayer().open({
      title: which === 'priv' ? '隐私政策' : '用户协议',
      sub: '随时可以回来查看这一份',
      noLater: true,
      okText: '关闭',
      foot: false
    });
  }

  Sleepy.legal = {
    USER_AGREEMENT: USER_AGREEMENT,
    PRIVACY_POLICY: PRIVACY_POLICY,
    AGREE_KEY: AGREE_KEY,
    AGREE_VER: AGREE_VER,
    agreedAt: agreedAt,
    isAgreed: isAgreed,
    markAgreed: markAgreed,
    resetAgreed: resetAgreed,
    maybeShowFirstRun: maybeShowFirstRun,
    openDoc: openDoc
  };

})(window);