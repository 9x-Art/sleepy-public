/* ============================================================
   page-workshop.js · App 工坊（第 4 批，总纲 20.3/20.4）

   user 的创作侧。三层数据：
     appTemplate   模板（六类内置 + user 自建；全局一份，跨岛可用）
     appInstallation  安装实例（某岛某 char 某部手机一份，相互隔离）
     appRecord     该 char 实际产生的记录（展示即 confirmed）

   预算红线：手动创建/改名/安装/卸载全部 0 次生成 API。
   正常查手机只能看，工坊永远不进偷看流程（总纲 20.3）。
   本文件同时是数据层（Sleepy.workshop）和页面（registry 'workshop'）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

  /* ---------------------------- 模板 ----------------------------
     六类成熟模板（总纲 20.4）：不做空白文本壳。字段跟类型走。 */

  var TEMPLATE_TYPES = {
    diary:    { name: '日记型',   icon: '✎', fields: '一天一页：日期 / 标题 / 正文' },
    checkin:  { name: '打卡型',   icon: '◉', fields: '每天一笔：日期 / 事项 / 完成了没' },
    fav:      { name: '收藏型',   icon: '❋', fields: '喜欢的东西：名字 / 为什么喜欢' },
    progress: { name: '进度型',   icon: '▤', fields: '一件事：在做什么 / 到哪儿了 / 备注' },
    file:     { name: '档案型',   icon: '❏', fields: '一个人或一件事：名字 / 详情' },
    timeline: { name: '时间线型', icon: '⋯', fields: '按时间走：什么时候 / 发生了什么' }
  };

  /* 内置模板是**虚**的（不落库）：id 固定，跨岛可用，不可删改 */
  function builtinTemplates() {
    return Object.keys(TEMPLATE_TYPES).map(function (t) {
      return { id: 'bt_' + t, name: TEMPLATE_TYPES[t].name, type: t,
        desc: TEMPLATE_TYPES[t].fields, builtin: true, color: '' };
    });
  }

  function allTemplates() {
    return builtinTemplates().concat(arr(store.get('wsTemplates')));
  }
  function findTemplate(id) {
    return allTemplates().filter(function (t) { return t.id === id; })[0] || null;
  }

  /* user 自建模板：选类型 + 起名 + 描述 + 强调色（0 API） */
  function createTemplate(o) {
    var type = TEMPLATE_TYPES[o.type] ? o.type : 'diary';
    var rec = {
      id: 'wt_' + newId(),
      name: clip(o.name, 12) || TEMPLATE_TYPES[type].name,
      type: type,
      desc: clip(o.desc, 60),
      color: /^#[0-9a-fA-F]{3,8}$/.test(o.color || '') ? o.color : '#B08A5E',
      builtin: false,
      at: Date.now()
    };
    var list = arr(store.get('wsTemplates'));
    list.push(rec);
    store.set('wsTemplates', list);
    return rec;
  }

  /* ---------------------------- 安装实例 ----------------------------
     同一模板装到多个 char = 多个独立实例，记录互不同步（总纲 20.4）。 */

  function allInstalls() { return arr(store.get('wsInstalls')); }

  function installsOfPhone(phoneId) {
    return allInstalls().filter(function (i) {
      return i.phoneId === phoneId;
    }).sort(function (a, b) { return a.at - b.at; });
  }

  function installsOfChar(sbId, charId) {
    return allInstalls().filter(function (i) {
      return i.sandboxId === sbId && i.charId === charId;
    });
  }

  /* 安装：给选定 char 的手机建独立实例。0 API。 */
  function install(sbId, phoneId, charId, templateId) {
    var t = findTemplate(templateId);
    if (!t) return { ok: false, message: '模板不存在' };
    var dupe = allInstalls().some(function (i) {
      return i.phoneId === phoneId && i.templateId === templateId;
    });
    if (dupe) return { ok: false, message: '他已经装着这个了' };
    var rec = core.tagScope({
      id: 'wi_' + newId(),
      phoneId: phoneId, charId: charId,
      templateId: templateId, templateName: t.name, templateType: t.type,
      color: t.color || '#B08A5E',
      charPerm: 'record',        /* char 使用权限：只记真实发生的事（v1 默认） */
      at: Date.now()
    }, sbId);
    var list = allInstalls();
    list.push(rec);
    store.set('wsInstalls', list);
    return { ok: true, install: rec };
  }

  /* 卸载：移除实例。记录归档保留（user 数据不悄悄消失），不再出现在手机上。 */
  function uninstall(installId) {
    store.set('wsInstalls', allInstalls().filter(function (i) { return i.id !== installId; }));
    var recs = arr(store.get('wsRecords')).map(function (r) {
      if (r.installationId === installId && r.status !== 'archived') r.status = 'archived';
      return r;
    });
    store.set('wsRecords', recs);
    return { ok: true };
  }

  /* ---------------------------- 记录 ---------------------------- */

  function recordsOf(installId) {
    return arr(store.get('wsRecords')).filter(function (r) {
      return r.installationId === installId && r.status !== 'archived';
    }).sort(function (a, b) { return b.at - a.at; });
  }

  function addRecord(installId, fields, srcId) {
    var inst = allInstalls().filter(function (i) { return i.id === installId; })[0];
    if (!inst) return null;
    var rec = core.tagScope({
      id: 'wr_' + newId(),
      installationId: installId,
      phoneId: inst.phoneId, charId: inst.charId,
      fields: fields || {},
      status: 'confirmed',                 /* 展示即事实，永不被重生成覆盖 */
      sourceType: srcId ? 'model_derived' : 'character_authored',
      runId: srcId || null,
      at: Date.now()
    }, inst.sandboxId);
    var list = arr(store.get('wsRecords'));
    list.push(rec);
    store.set('wsRecords', list);
    return rec;
  }

  /* 结算来的记录：按模板名找该手机上的安装实例（模型不知道实例 id） */
  function addRecordByName(phoneId, templateName, fields, runId) {
    var inst = allInstalls().filter(function (i) {
      return i.phoneId === phoneId && i.templateName === clip(templateName, 12);
    })[0];
    if (!inst) return null;
    return addRecord(inst.id, fields, runId);
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.workshop = {
    TEMPLATE_TYPES: TEMPLATE_TYPES,
    allTemplates: allTemplates,
    findTemplate: findTemplate,
    createTemplate: createTemplate,
    installsOfPhone: installsOfPhone,
    installsOfChar: installsOfChar,
    install: install,
    uninstall: uninstall,
    recordsOf: recordsOf,
    addRecord: addRecord,
    addRecordByName: addRecordByName
  };

  /* ============================================================
     工坊页面（user 创作侧主入口，第 2 屏「工坊」格）
     ============================================================ */

  Sleepy.register('workshop', {
    title: '工坊',
    render: function workshopRender(ctx) {
      ctx.rebuild = function () { workshopRender(ctx); };
      var sb = core.activeSandbox();
      ctx.setTitle('工坊');
      ctx.body.innerHTML = '';

      var lead = h('p', 'ph-entry-lead',
        '你做小东西的地方 —— 做好可以装进他们的手机里，装给几个人就各自独立记各自的。');
      ctx.body.appendChild(lead);

      /* ---- 模板 ---- */
      var tplSec = h('div', 'ws-sec');
      tplSec.appendChild(h('div', 'ph-sec', '模板'));
      var tList = h('div', 'ws-tpl');
      Sleepy.workshop.allTemplates().forEach(function (t) {
        var card = h('div', 'ws-tpl-card');
        var head = h('div', 'ws-tpl-head');
        head.appendChild(h('span', 'ws-tpl-badge', templateIcon(t)));
        var nm = h('span', 'ws-tpl-name');
        nm.appendChild(h('b', null, t.name));
        nm.appendChild(h('small', null, TEMPLATE_TYPES[t.type].name + (t.builtin ? ' · 内置' : ' · 你做的')));
        head.appendChild(nm);
        card.appendChild(head);
        card.appendChild(h('p', 'ws-tpl-desc', t.desc || TEMPLATE_TYPES[t.type].fields));
        var acts = h('div', 'ws-tpl-acts');
        if (!t.builtin) {
          var del = h('button', 'ws-mini', '删除');
          del.type = 'button';
          del.addEventListener('click', function () {
            /* ui.confirm 是**Promise 版**，只收一个对象（ui.js:476）。
               以前写成 (文案, 回调) 的旧签名 → 回调永远不会执行，按钮点着没反应。 */
            ui.confirm({
              title: '删掉「' + t.name + '」？装出去的实例会一起消失。',
              ok: '删除', danger: true
            }).then(function (yes) {
              if (!yes) return;
              store.set('wsTemplates', arr(store.get('wsTemplates')).filter(function (x) { return x.id !== t.id; }));
              /* 实例一起撤（记录归档） */
              arr(store.get('wsInstalls')).filter(function (i) { return i.templateId === t.id; })
                .forEach(function (i) { Sleepy.workshop.uninstall(i.id); });
              ctx.toast('删掉了', 'ok');
              ctx.rebuild();
            });
          });
          acts.appendChild(del);
        }
        var btn = h('button', 'ws-mini ws-mini-primary', '装给谁');
        btn.type = 'button';
        btn.addEventListener('click', function () { openInstallDrawer(ctx, t); });
        acts.appendChild(btn);
        card.appendChild(acts);
        tList.appendChild(card);
      });
      tplSec.appendChild(tList);
      ctx.body.appendChild(tplSec);

      /* ---- 新建模板（手动，0 API） ---- */
      var mk = h('button', 'ws-new', '＋ 新做一个模板');
      mk.type = 'button';
      mk.addEventListener('click', function () { openCreateDrawer(ctx); });
      ctx.body.appendChild(mk);

      /* ---- 岛里的安装情况 ---- */
      if (sb) {
        var instSec = h('div', 'ws-sec');
        instSec.appendChild(h('div', 'ph-sec', '这座岛上的安装'));
        var chars = core.charsOfSandbox(sb.id).filter(function (c) { return (c.kind || 'main') === 'main'; });
        var any = false;
        chars.forEach(function (c) {
          Sleepy.workshop.installsOfChar(sb.id, c.id).forEach(function (inst) {
            any = true;
            var row = h('div', 'ws-inst-row');
            row.appendChild(h('span', 'ws-inst-dot', templateIcon({ type: inst.templateType, color: inst.color })));
            row.appendChild(h('span', 'ws-inst-name',
              (c.name || '?') + ' 的「' + inst.templateName + '」'));
            var n = Sleepy.workshop.recordsOf(inst.id).length;
            row.appendChild(h('span', 'ws-inst-count', n ? n + ' 条记录' : '还没有记录'));
            var rm = h('button', 'ws-mini', '卸载');
            rm.type = 'button';
            rm.addEventListener('click', function () {
              ui.confirm({
                title: '从 ' + (c.name || '?') + ' 的手机上卸下「' + inst.templateName + '」？',
                ok: '卸载', danger: true
              }).then(function (yes) {
                if (!yes) return;
                Sleepy.workshop.uninstall(inst.id);
                ctx.toast('卸下了', 'ok');
                ctx.rebuild();
              });
            });
            row.appendChild(rm);
            instSec.appendChild(row);
          });
        });
        if (!any) instSec.appendChild(h('p', 'ph-entry-note', '还没装过 —— 上面的模板点「装给谁」就开始。'));
        ctx.body.appendChild(instSec);
      } else {
        ctx.body.appendChild(h('p', 'ph-entry-note', '还没有进入任何一座岛。'));
      }
    },
    onShow: function (ctx) {
      if (ctx.__painted && ctx.rebuild) ctx.rebuild();
      else ctx.__painted = true;
    }
  });

  function templateIcon(t) {
    var tt = TEMPLATE_TYPES[t.type] || TEMPLATE_TYPES.diary;
    return tt.icon;
  }

  /* ---- 新建抽屉：选类型 + 起名 + 一句描述（0 API） ---- */
  function openCreateDrawer(ctx) {
    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', '新做一个模板'));
    panel.appendChild(h('p', 'iol-drawer-desc',
      '选一个骨架，起个名字。创建不花生成次数；装出去之后他自己往上记。'));

    var type = 'diary';
    var typeRow = h('div', 'ws-types');
    Object.keys(TEMPLATE_TYPES).forEach(function (k) {
      var b = h('button', 'ws-type' + (k === type ? ' is-on' : ''),
        TEMPLATE_TYPES[k].icon + ' ' + TEMPLATE_TYPES[k].name);
      b.type = 'button';
      b.addEventListener('click', function () {
        type = k;
        typeRow.querySelectorAll('.ws-type').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
      });
      typeRow.appendChild(b);
    });
    panel.appendChild(typeRow);

    var nameIn = h('input', 'ws-input');
    nameIn.placeholder = '名字（比如：观影记录）';
    nameIn.maxLength = 12;
    var descIn = h('input', 'ws-input');
    descIn.placeholder = '一句话说明（可以不填）';
    descIn.maxLength = 40;
    panel.appendChild(nameIn);
    panel.appendChild(descIn);

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不做');
    var ok = h('button', 'iol-drawer-cancel ws-primary', '做好');
    ok.type = 'button'; cancel.type = 'button';
    ok.addEventListener('click', function () {
      if (!clip(nameIn.value, 12)) { ctx.toast('起个名字嘛', 'warn'); return; }
      Sleepy.workshop.createTemplate({ name: nameIn.value, type: type, desc: descIn.value });
      ctx.toast('做好了 —— 点「装给谁」安装', 'ok');
      close();
      ctx.rebuild();
    });
    cancel.addEventListener('click', close);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
  }

  /* ---- 安装抽屉：勾选岛里的角色（一次装多个，实例相互隔离） ---- */
  function openInstallDrawer(ctx, tpl) {
    var sb = core.activeSandbox();
    if (!sb) { ctx.toast('先进入一座岛', 'warn'); return; }
    var mains = core.charsOfSandbox(sb.id).filter(function (c) { return (c.kind || 'main') === 'main'; });
    if (!mains.length) { ctx.toast('这座岛上还没有角色', 'warn'); return; }

    /* 挂到 #phone 而不是 ctx.el：.page 上有 transform，fixed 会失效（见文件头注释） */
    var host = document.getElementById('phone') || document.body;
    var old = host.querySelector('.iol-drawer');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var wrap = h('div', 'iol-drawer');
    var panel = h('div', 'iol-drawer-panel');
    panel.appendChild(h('h2', '', '装「' + tpl.name + '」给谁？'));
    panel.appendChild(h('p', 'iol-drawer-desc',
      '装给几个人就各自独立记各自的，互不同步。安装不花生成次数。'));

    var picks = {};
    mains.forEach(function (c) {
      var lab = h('label', 'ws-pick');
      var input = h('input');
      input.type = 'checkbox';
      input.checked = true;
      input.addEventListener('change', function () { picks[c.id] = input.checked; });
      picks[c.id] = true;
      lab.appendChild(input);
      lab.appendChild(h('span', null, c.name || '?'));
      panel.appendChild(lab);
    });

    var actions = h('div', 'iol-drawer-actions');
    var cancel = h('button', 'iol-drawer-cancel', '先不装');
    var ok = h('button', 'iol-drawer-cancel ws-primary', '装上');
    ok.type = 'button'; cancel.type = 'button';
    ok.addEventListener('click', function () {
      var ph = Sleepy.phone;
      var n = 0;
      mains.forEach(function (c) {
        if (!picks[c.id]) return;
        var phoneRec = ph.ensurePhone(sb.id, c.id);
        var r = Sleepy.workshop.install(sb.id, phoneRec.id, c.id, tpl.id);
        if (r.ok) n++;
        else ctx.toast(c.name + '：' + r.message, 'warn');
      });
      if (n) ctx.toast('装好了 ' + n + ' 份 —— 去他的手机看看', 'ok');
      close();
      ctx.rebuild();
    });
    cancel.addEventListener('click', close);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    panel.appendChild(actions);

    function close() {
      wrap.classList.remove('show');
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 240);
    }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    wrap.appendChild(panel);
    host.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
  }

})(window);
