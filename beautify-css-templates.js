/* ============================================================
   beautify-css-templates.js — 美化 CSS 预设模板（2026-11-01）

   给「角色外观 → CSS 高级自定义」（page-char-appearance）和
   「群聊美化」（page-group）共用的预设模板清单 + 挂载助手。

   为什么单独一个文件：模板是**纯数据 + 一段两页复用的 UI 逻辑**，
   放在任一页面文件里都会让另一页产生依赖；两页的 textarea 落库链路
   不同（cfg.customCss vs g.beautifyCss），但「填入 + 复制」的交互一样。

   交互：点 chip = 把模板填进 textarea（走各页已有的 input 落库 +
   实时预览链路，helper 只负责 setText + 派发 input）；长按 chip =
   把模板原文复制到剪贴板（不填入）。框里已有内容时先 ui.confirm。

   选择器口径：私聊 .msg-bubble / .msg-text / .msg-time / .msg-assistant /
   .msg-user；群聊 .gc-bubble / .gc-name / .gc-time / .gc-list /
   .gc-row.is-me。全部带 !important —— 美化 CSS 注入在页面样式表之后，
   但外观预设自己也会生成一段 CSS，用 !important 保证模板压得过预设。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* ---- 模板清单（纯数据，改样式只动这里）---- */
  var TEMPLATES = [
    {
      name: '奶油软糖',
      desc: '大圆角 · 奶油粉渐变气泡',
      css:
'/* 奶油软糖：大圆角 + 奶油粉渐变 */\n' +
'.msg-bubble{ border-radius:18px 18px 18px 6px !important;\n' +
'  box-shadow:0 4px 14px rgba(214,170,180,.25) !important; }\n' +
'.msg-user .msg-bubble{ border-radius:18px 18px 6px 18px !important;\n' +
'  background:linear-gradient(135deg,#FFE9EF,#FFD9E4) !important; color:#7A4A5A !important; }\n' +
'.msg-assistant .msg-bubble{ background:linear-gradient(135deg,#FFF9F0,#FFF1E3) !important; color:#6B5644 !important; }\n' +
'.msg-time{ color:#B49BA6 !important; }\n' +
'/* 群聊同步（群聊美化页用得到） */\n' +
'.gc-bubble{ border-radius:18px 18px 18px 6px !important; }\n' +
'.gc-row.is-me .gc-bubble{ background:linear-gradient(135deg,#FFE9EF,#FFD9E4) !important; color:#7A4A5A !important; }'
    },
    {
      name: '星夜深空',
      desc: '深色气泡 · 银蓝描边，亮底暗底都压得住',
      css:
'/* 星夜深空：深色气泡 + 冷光 */\n' +
'.msg-bubble{ background:#232B3A !important; color:#D9E2F2 !important;\n' +
'  border-radius:14px !important; box-shadow:0 6px 18px rgba(20,26,40,.30) !important; }\n' +
'.msg-user .msg-bubble{ background:linear-gradient(135deg,#2E4162,#3B5480) !important; }\n' +
'.msg-time{ color:#8A97B0 !important; }\n' +
'.msg-text .md-quote{ border-left-color:#5B7BB4 !important; color:#9FB0CE !important; }\n' +
'/* 群聊同步 */\n' +
'.gc-bubble{ background:#232B3A !important; color:#D9E2F2 !important; border-radius:14px !important; }\n' +
'.gc-row.is-me .gc-bubble{ background:linear-gradient(135deg,#2E4162,#3B5480) !important; }\n' +
'.gc-time{ color:#8A97B0 !important; }'
    },
    {
      name: '白瓷极简',
      desc: '去阴影 · 细描边，一眼清爽',
      css:
'/* 白瓷极简：去阴影、细边框 */\n' +
'.msg-bubble{ background:#FFFFFF !important; border:1px solid rgba(0,0,0,.08) !important;\n' +
'  box-shadow:none !important; border-radius:10px !important; padding:8px 12px !important; }\n' +
'.msg-time{ opacity:.6 !important; letter-spacing:.02em !important; }\n' +
'/* 群聊同步 */\n' +
'.gc-bubble{ background:#FFFFFF !important; border:1px solid rgba(0,0,0,.08) !important;\n' +
'  box-shadow:none !important; border-radius:10px !important; }'
    },
    {
      name: '信纸手记',
      desc: '衬线字 · 纸张底色，像手写的信',
      css:
'/* 信纸手记：衬线 + 纸张感（不上斜体，保可读性） */\n' +
'.msg-text{ font-family:Georgia,"Songti SC",serif !important;\n' +
'  letter-spacing:.02em !important; }\n' +
'.msg-bubble{ background:#FDFBF4 !important; color:#4A4234 !important;\n' +
'  border-radius:2px 10px 2px 10px !important;\n' +
'  box-shadow:0 1px 4px rgba(120,100,60,.18) !important; }\n' +
'.gc-bubble{ background:#FDFBF4 !important; color:#4A4234 !important;\n' +
'  border-radius:2px 10px 2px 10px !important; }'
    }
  ];

  /* ---- 剪贴板（textarea 兜底，file:// / 老 WebView 的 navigator.clipboard 不可靠）---- */
  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); },
          function () { resolve(legacyCopy(text)); });
      } else { resolve(legacyCopy(text)); }
    });
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ---- 长按判定：pointerdown 起 550ms 计时，pointerup/leave 先到 = 点击 ---- */
  function bindChip(btn, tpl, handlers) {
    var timer = null;
    var longFired = false;
    btn.addEventListener('pointerdown', function () {
      longFired = false;
      timer = setTimeout(function () {
        longFired = true;
        handlers.copy(tpl);
      }, 550);
    });
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (longFired) { longFired = false; return; } /* 长按已处理，别再触发填入 */
      handlers.fill(tpl);
    });
  }

  /* ---- 挂载入口：两页各调一次 ----
     opts = {
       area:    目标 textarea（必传）
       toast:   function(msg, type)（必传，透传页面 ctx.toast）
       confirm: function(opts) -> Promise<bool>（可选；不传则已有内容时直接覆盖）
     } */
  function mount(container, opts) {
    if (!container || !opts || !opts.area) return;
    var row = document.createElement('div');
    row.className = 'cap-chips beautify-tpl-chips';
    TEMPLATES.forEach(function (tpl) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cap-chip';
      b.textContent = tpl.name;
      b.title = tpl.desc;
      bindChip(b, tpl, {
        fill: function (t) {
          var apply = function () {
            opts.area.value = t.css;
            /* 派发 input：让两页各自的落库 + 实时预览监听自己跑 */
            opts.area.dispatchEvent(new Event('input', { bubbles: true }));
            if (opts.toast) opts.toast('已填入「' + t.name + '」，可在框里继续改', 'ok');
          };
          if (opts.area.value.trim() && opts.confirm) {
            opts.confirm({
              title: '框里已有自定义样式，填入会覆盖',
              ok: '覆盖填入',
              danger: false
            }).then(function (yes) { if (yes) apply(); });
          } else { apply(); }
        },
        copy: function (t) {
          copyText(t.css).then(function (ok) {
            if (opts.toast) opts.toast(ok ? '已复制「' + t.name + '」模板' : '没拿到剪贴板权限', ok ? 'ok' : 'err');
          });
        }
      });
      row.appendChild(b);
    });
    container.appendChild(row);
    var hint = document.createElement('p');
    hint.className = 'cap-hint';
    hint.textContent = '点模板直接填入 · 长按复制模板原文';
    container.appendChild(hint);
  }

  Sleepy.beautifyCssTemplates = {
    list: TEMPLATES,
    mount: mount
  };
})(window);
