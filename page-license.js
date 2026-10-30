/* ============================================================
   page-license.js — 我的授权（账密系统，方案-账密系统-v2，2026-10-21）

   激活码即账号（发售路线 §三/§十）：
   · 没激活：激活（发码页领的码 + 发码时登记的 QQ + 设密码）或登录（QQ+密码）
   · 已激活：状态卡（QQ 尾号 / 设备数 / 最近校验）+ 设备管理（解绑）+ 改密 + 注销
   纪律：本页只碰「授权」—— 不含任何备份/同步逻辑（账号与存储解耦）。

   内测期不设强闸的口径已更新（2026-10-23）：**授权闸已接进启动链** ——
   app.js 的 bootHome 先看 repo.licenseGateState()，不是 ok 就把本文件的
   licenseGate 画在 home 位，过审才挂桌面。设置里的 license 页退化成
   「已激活后的管理页」（改密 / 设备 / 注销），激活/登录表单只活在闸上。
   ============================================================ */
(function (global) {
  'use strict';

  global.Sleepy = global.Sleepy || {};
  var Sleepy = global.Sleepy;
  var repo = Sleepy.repo;
  var ui = Sleepy.ui;
  var h = ui.h;

  /* （原「内测一键进门」临时通道已于 2026-10-25 整段下线：
     前端常量/函数/接线/CSS 四处已删；云端那行公用码记得作废
     UPDATE codes SET status = 0 WHERE code = 'SLP-BETA'。
     worker 对 status=2 的支持保留没动 —— 只是云端不再有这种码。） */

  function qqTail(qq) {
    var s = String(qq || '');
    return s.length > 4 ? '尾号 ' + s.slice(-4) : s;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  /* 激活 / 登录表单 —— 门面（启动闸）和设置页共用这一份（逻辑只写一份）。
     hooks.toast(msg, kind) 弹提示；hooks.onSuccess() 在激活/登录成功后回调
     （闸 → 放行重进；设置页 → 重建回已激活视图）。
     两个 build 各自返回一个 .set-group；buildGuestForms 是设置页用的
     「两块叠着」拼法。启动闸走分步（一次只出一块），见文件尾 mount。 */
  function buildActivateForm(hooks) {
    var gAct = h('div', 'set-group');
    gAct.appendChild(h('p', 'set-group-title', '激活'));
    var fCode = ui.textField({ label: '激活码', placeholder: 'SLP-…（发码页领的）' });
    var fQQ = ui.textField({ label: 'QQ 号', placeholder: '领码时登记的那个', inputmode: 'numeric' });
    var fPass = ui.textField({ label: '设置密码（至少 6 位）', password: true });
    var fPass2 = ui.textField({ label: '再输一遍密码', password: true });
    [fCode, fQQ, fPass, fPass2].forEach(function (f) { gAct.appendChild(f.el); });
    gAct.appendChild(ui.button('激活', 'primary', function () {
      var code = fCode.get().trim().toUpperCase();
      var qq = fQQ.get().trim();
      var p1 = fPass.get(), p2 = fPass2.get();
      if (!code || !qq) { hooks.toast('激活码和 QQ 号都要填', 'warn'); return; }
      if (p1.length < 6) { hooks.toast('密码至少 6 位', 'warn'); return; }
      if (p1 !== p2) { hooks.toast('两次密码不一样', 'warn'); return; }
      hooks.toast('正在激活…');
      repo.licenseActivate(code, qq, p1, function (r) {
        if (r.ok) { hooks.toast('激活好了', 'ok'); hooks.onSuccess(); }
        else hooks.toast(r.message || '没激活成', 'warn');
      });
    }));
    return gAct;
  }

  function buildLoginForm(hooks) {
    /* 登录（换设备来的） */
    var gIn = h('div', 'set-group');
    gIn.appendChild(h('p', 'set-group-title', '登录（换设备 / 重新登录）'));
    var lQQ = ui.textField({ label: 'QQ 号', inputmode: 'numeric' });
    var lPass = ui.textField({ label: '密码', password: true });
    gIn.appendChild(lQQ.el);
    gIn.appendChild(lPass.el);
    gIn.appendChild(ui.button('登录', 'ghost', function () {
      var qq = lQQ.get().trim(), p = lPass.get();
      if (!qq || !p) { hooks.toast('QQ 号和密码都要填', 'warn'); return; }
      hooks.toast('正在登录…');
      repo.licenseLogin(qq, p, function (r) {
        if (r.ok) { hooks.toast('登录好了', 'ok'); hooks.onSuccess(); }
        else if (r.status === 403 && r.devices && r.devices.length) {
          /* 设备满 3 台：把清单念出来 + 指去老设备解绑（防误封体验，发售路线硬要求） */
          var names = r.devices.map(function (d) {
            return shortUa(d.ua) + '（' + fmtTime(d.last_seen) + '）';
          }).join('；');
          hooks.toast('设备满 3 台：' + names + ' —— 到还在用的那台设备上「解绑」一台再登录', 'warn');
        } else {
          hooks.toast(r.message || '没登上', 'warn');
        }
      });
    }));
    return gIn;
  }

  function buildGuestForms(onto, hooks) {
    onto.appendChild(buildActivateForm(hooks));
    onto.appendChild(buildLoginForm(hooks));
    onto.appendChild(h('p', 'set-foot', '还没领激活码？到发码页用 QQ 号免费领取（地址在群内公告）。密码忘了：换设备前先在这台设备上改密；设备全丢了联系群内人工处理。'));
  }

  Sleepy.register('license', {
    title: '我的授权',
    render: function (ctx) {
      var body = ctx.body;
      body.innerHTML = '';

      function build() {
        body.innerHTML = '';
        var lic = repo.license();

        if (!lic || !lic.token) {
          renderGuest();
        } else {
          renderActive(lic);
        }
      }

      /* ---------------- 未激活：激活 / 登录（表单与启动闸共用一份） ---------------- */
      function renderGuest() {
        var intro = h('div', 'set-group');
        intro.appendChild(h('p', 'set-group-note',
          'Sleepy 用「激活码」做账号：到发码页用 QQ 号免费领码（一个 QQ 只能领一次），' +
          '然后在这里激活并设置密码；换设备用 QQ 号 + 密码登录，最多 3 台，可自助解绑。'));
        body.appendChild(intro);

        buildGuestForms(body, { toast: ctx.toast, onSuccess: build });
      }

      /* ---------------- 已激活：状态 + 设备管理 + 改密 + 注销 ---------------- */
      function renderActive(lic) {
        var gStat = h('div', 'set-group');
        gStat.appendChild(h('p', 'set-group-title', '授权状态'));
        var stat = h('p', 'set-group-note', '正在核对…');
        gStat.appendChild(stat);
        var devList = h('div');
        gStat.appendChild(devList);
        body.appendChild(gStat);

        repo.licenseMe(function (r) {
          if (!r.ok) {
            /* 会话失效（被踢/过期）：如实降级回未激活态 */
            stat.textContent = r.status === 401
              ? '登录状态失效了（可能被解绑），重新登录一下。'
              : ('核对失败：' + (r.message || '连不上'));
            if (r.status === 401) build();   /* build 是函数声明，已提升，直接重建回 guest 态 */
            return;
          }
          var devs = r.devices || [];
          stat.textContent = '账号 ' + qqTail(r.qq) + ' · 已授权 ' + devs.length + '/3 台 · 最近核对 ' + fmtTime(Date.now());
          devList.innerHTML = '';
          devs.forEach(function (d) {
            var row = h('div', 'vec-row');
            var main = h('div', 'vec-row-main');
            main.appendChild(h('div', 'vec-row-name', shortUa(d.ua) + (isSelf(d) ? ' · 本机' : '')));
            main.appendChild(h('div', 'vec-row-meta', '上次活跃 ' + fmtTime(d.last_seen)));
            row.appendChild(main);
            /* 解绑钮：别的设备和本机都给 —— 2026-10-30 用户实锤的 UX 陷阱：
               本机那行以前没有解绑钮，想腾出本机名额只能去别的设备操作；
               在本机只能「退出登录」，而那**只杀会话不解绑**，设备数不动
               （云端 D1 时间线实锤：登录→64 秒后退出→设备行仍 status=1）。 */
            row.appendChild(ui.button(isSelf(d) ? '解绑本机' : '解绑', 'danger', function () {
              ui.confirm({
                title: isSelf(d) ? '解绑本机？' : '解绑这台设备？',
                note: isSelf(d)
                  ? '本机的登录会立刻失效，名额即刻释放；之后想在这台设备用，重新登录一次就行。'
                  : shortUa(d.ua) + ' 上的登录会立刻失效。解绑后腾出的名额可以给新设备用。',
                ok: '解绑', danger: true
              }).then(function (yes) {
                if (!yes) return;
                repo.licenseRevoke(d.id, function (rr) {
                  if (rr.ok && isSelf(d)) {
                    /* 本机解绑 = 会话跟着一起没；照 logout 把本地凭据清掉。
                       logout 那一发请求会 401（会话已死），但本地照样清 ——
                       licLogout 本来就是「请求失败也清」。 */
                    repo.licenseLogout(function () {
                      ctx.toast('解绑了，本机登录已失效', 'ok');
                      build();
                    });
                    return;
                  }
                  ctx.toast(rr.ok ? '解绑了' : (rr.message || '没解绑成'), rr.ok ? 'ok' : 'warn');
                  if (rr.ok) build();
                });
              });
            }));
            devList.appendChild(row);
          });
        });

        /* 改密 */
        var gPwd = h('div', 'set-group');
        gPwd.appendChild(h('p', 'set-group-title', '改密码'));
        var oPass = ui.textField({ label: '老密码', password: true });
        var nPass = ui.textField({ label: '新密码（至少 6 位）', password: true });
        gPwd.appendChild(oPass.el);
        gPwd.appendChild(nPass.el);
        gPwd.appendChild(ui.button('改密码', 'ghost', function () {
          var o = oPass.get(), n = nPass.get();
          if (!o || n.length < 6) { ctx.toast('老密码要填，新密码至少 6 位', 'warn'); return; }
          repo.licensePassword(o, n, function (r) {
            ctx.toast(r.ok ? '改好了，这台设备不用重新登录' : (r.message || '没改成'), r.ok ? 'ok' : 'warn');
            if (r.ok) { oPass.input.value = ''; nPass.input.value = ''; }
          });
        }));
        body.appendChild(gPwd);

        /* 登出 / 注销 */
        var gOut = h('div', 'set-group');
        gOut.appendChild(ui.button('退出登录（本机，名额不释放）', 'ghost', function () {
          repo.licenseLogout(function () {
            ctx.toast('退出了', 'ok');
            build();
          });
        }));
        gOut.appendChild(ui.button('注销账号（删除 QQ 号记录）', 'danger', function () {
          ui.confirm({
            title: '注销账号？',
            note: '所有设备的登录会立刻失效，QQ 号记录被删除（发货账目按规则保留）。激活码不能重复使用，注销后想再用需要人工恢复 —— 想清楚再点。',
            ok: '注销', danger: true
          }).then(function (yes) {
            if (!yes) return;
            var f = ui.prompt({ title: '输密码确认注销', ok: '确认注销' });
            f.then(function (pass) {
              if (!pass) return;
              repo.licenseForget(pass, function (r) {
                ctx.toast(r.ok ? '注销了' : (r.message || '没注销成'), r.ok ? 'ok' : 'warn');
                if (r.ok) build();
              });
            });
          });
        }));
        body.appendChild(gOut);

        var foot = h('p', 'set-foot', '授权只在核对时联网，聊天与数据照旧全在本机。密码忘了：换设备前先在这台设备上改密；设备全丢了联系群内人工处理。');
        body.appendChild(foot);
      }

      /* 本机判定：worker 把 install_id 一起下发，比对本机安装 id */
      function isSelf(dev) {
        return repo.deviceId() === dev.install_id;
      }

      build();
      ctx.rebuild = build;
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  /* UA → 人话设备名（够认就行，不追求全） */
  function shortUa(ua) {
    var s = String(ua || '未知设备');
    if (s.length > 60 || /[\u4e00-\u9fa5]/.test(s) === false && s.length > 40) s = s.slice(0, 40);
    if (/iPhone/i.test(s)) return 'iPhone';
    if (/iPad/i.test(s)) return 'iPad';
    if (/Android/i.test(s)) return 'Android 手机';
    if (/MicroMessenger/i.test(s)) return '微信内置浏览器';
    if (/Edg/i.test(s)) return 'Edge 浏览器';
    if (/Chrome/i.test(s)) return 'Chrome 浏览器';
    if (/Firefox/i.test(s)) return 'Firefox 浏览器';
    if (/Safari/i.test(s)) return 'Safari 浏览器';
    if (/Windows/i.test(s)) return 'Windows 设备';
    if (/Mac/i.test(s)) return 'Mac 设备';
    return '一台设备';
  }

  /* ==================== 启动授权闸（2026-10-23 接进 bootHome） ====================

     账密系统是进入 sleepy 的门槛，不是进去后在设置里补填的东西。
     app.js 的 bootHome 在挂桌面之前调 state()：不是 'ok' 就 mount() 到
     home 位画门面，激活/登录成功回调 onPass → bootHome.force() 重进。
     判定唯一出处是 repo.licenseGateState()，这里不自己拼逻辑。 */
  Sleepy.licenseGate = {
    state: function () { return repo.licenseGateState(); },

    mount: function (el, onPass) {
      el.innerHTML = '';
      var wrap = h('div', 'license-gate');
      wrap.appendChild(h('p', 'license-gate-brand', 'Sleepy'));
      wrap.appendChild(h('p', 'license-gate-sub', '先过授权，再进门'));

      var note = h('p', 'license-gate-note');
      var forms = h('div', 'license-gate-forms');
      wrap.appendChild(note);
      wrap.appendChild(forms);
      el.appendChild(wrap);

      var gateToast = function (msg, kind) { Sleepy.toast(msg, kind); };   /* 全局 toast（app.js），页面栈外没有 ctx.toast */

      /* （原内测一键进门接线已于 2026-10-25 拆除，进门直接走分步表单。） */

      /* 分步出（用户 2026-10-23 点名）：像游戏的注册→登录 ——
         第一步激活设完密码**不直接进门**，跳到登录步把 QQ + 密码
         再输一次，核对通过才算进门（onPass 只挂在登录成功上）。 */
      function show(step) {
        forms.innerHTML = '';
        if (step === 'login') {
          note.textContent = '换设备来的：用领码时登记的 QQ 号 + 密码登录（最多 3 台，可自助解绑）。';
          forms.appendChild(buildLoginForm({ toast: gateToast, onSuccess: onPass }));
          forms.appendChild(stepLink('还没有激活过？', '去激活', function () { show('activate'); }));
        } else {
          note.textContent = '第一步激活：到发码页用 QQ 号免费领码（一个 QQ 只能领一次），填进来设个密码。';
          forms.appendChild(buildActivateForm({
            toast: gateToast,
            /* 激活成功 ≠ 进门：转登录步再核一次（注册→登录的仪式感，
               也顺手把密码记进肌肉记忆 —— onPass 只在登录步给）。 */
            onSuccess: function () { show('login'); }
          }));
          forms.appendChild(stepLink('换设备 / 重新登录的', '去登录', function () { show('login'); }));
        }
        forms.appendChild(h('p', 'set-foot', '密码忘了：换设备前先在这台设备上改密；设备全丢了联系群内人工处理。'));
      }
      show('activate');
    }
  };

  /* 步间切换入口：一行小字 + 可点的短语（set-foot 同款灰阶，不抢表单） */
  function stepLink(pre, word, go) {
    var p = h('p', 'license-gate-switch');
    var a = h('span', 'license-gate-switch-btn', word);
    a.addEventListener('click', go);
    p.appendChild(document.createTextNode(pre + ' '));
    p.appendChild(a);
    return p;
  }
})(window);
