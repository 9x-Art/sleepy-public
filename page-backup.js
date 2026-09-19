/* ============================================================
   page-backup.js — 数据与备份
   依赖：store.js、ui.js、app.js（必须在它们之后加载）
   覆盖 ROADMAP：2.5 导出/导入 · 2.6 体积 + 清理 · 2.7 清除数据
   页面：settings-backup（从 设置 → 数据与备份 进入）

   为什么是 .json 而不是 ZIP：
     压缩得引第三方库，和「零依赖 + 全原创」两条原则都冲突。
     v1 先用 .json 全量存档，结构就是 store.exportAll() 那个。
     以后真要有压缩需求，优先等原生 CompressionStream 铺开，
     而不是往工程里塞一个别人的库。
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
  var button = ui.button;
  var fmtBytes = ui.fmtBytes;
  var downloadText = ui.downloadText;

  var FILE_PREFIX = 'sleepy';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function stamp() {
    var d = new Date();
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
           '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /* 下载逻辑已经提到 ui.downloadText（导出人设预设也要用），这里不再自留一份 */

  Sleepy.register('settings-backup', {
    title: '数据与备份',
    render: function (ctx) {
      var body = ctx.body;

      /* ---------------- 导入用的隐藏 file input ---------------- */

      var fileInput = h('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', onPick);
      body.appendChild(fileInput);

      function onPick() {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        var reader = new global.FileReader();
        reader.onload = function () {
          var data = null;
          try { data = JSON.parse(String(reader.result)); } catch (e) { data = null; }
          if (!data) {
            ctx.toast('这个文件读不出内容，确认选的是 Sleepy 的备份 json', 'err');
            return;
          }
          var res = store.importAll(data);
          if (!res.ok) { ctx.toast(res.message || '导入失败', 'err'); return; }
          ctx.toast('导入成功，正在刷新…', 'ok');
          setTimeout(function () { global.location.reload(); }, 700);
        };
        reader.onerror = function () { ctx.toast('读取文件失败', 'err'); };
        reader.readAsText(f);
        fileInput.value = '';
      }

      /* ---------------------------- 备份 ---------------------------- */

      var g1 = group('备份',
        '导出的是 Sleepy 自己的存档格式（.json），换设备时用它搬家。' +
        '**图片不在里面** —— 那些存在图库里（IndexedDB），换设备要重新传一次。');
      g1.card.appendChild(row({
        label: '导出备份',
        hint: '含设置、Key 和以后的所有聊天记录',
        value: fmtBytes(store.usage().bytes),
        onClick: function () { doExport(); }
      }));
      g1.card.appendChild(row({
        label: '导入备份',
        hint: '会覆盖当前数据，导之前先导出一次',
        onClick: function () { fileInput.click(); }
      }));
      body.appendChild(g1.wrap);

      /* -------------------------- 存储空间 -------------------------- */

      var g2 = group('存储空间', '只统计 Sleepy 自己的键，不碰同域下别的数据。');
      var rowSize = row({ label: '已用空间', plain: true });
      var rowCount = row({ label: '存储项', plain: true });
      var rowState = row({ label: '写入状态', plain: true });
      g2.card.appendChild(rowSize);
      g2.card.appendChild(rowCount);
      g2.card.appendChild(rowState);
      body.appendChild(g2.wrap);

      /* -------------------------- 图库（IndexedDB） --------------------------

         图片本体**不在**上面那三个数里：它们在 IndexedDB，配额是磁盘级的
         （几百 MB 起），所以这里单独一组。用户要的「方便之后存图」就是这一层。 */
      var gLib = group('图库',
        '照片、聊天里发的图存在这里（IndexedDB）。它不占 localStorage 那 5MB，' +
        '所以上面那几个数字看不见它们。');

      var rowLibSize = row({ label: '图库占用', plain: true });
      var rowLibCount = row({ label: '图片张数', plain: true });
      var rowLibState = row({ label: '存放位置', plain: true });
      gLib.card.appendChild(rowLibSize);
      gLib.card.appendChild(rowLibCount);
      gLib.card.appendChild(rowLibState);
      body.appendChild(gLib.wrap);

      /* 清图库：同样是破坏性操作，走两次点击确认（跟「清除全部数据」一个规矩）。
         **只清图片本体**，聊天记录 / 相册列表不动 —— 那些记录会显示成
         「这张图找不到了」，用户至少知道自己删过什么。 */
      var libArmed = false;
      var libTimer = null;
      var libBtn = button('清空图库（只删图片本身）', 'ghost', function () {
        if (!libArmed) {
          libArmed = true;
          libBtn.textContent = '再点一次，确认清空';
          libBtn.classList.add('is-armed');
          libTimer = setTimeout(resetLibArm, 4000);
          return;
        }
        resetLibArm();
        if (!Sleepy.media) return;
        Sleepy.media.clear().then(function () {
          ctx.toast('图库已清空', 'ok');
          refresh();
        }, function (e) {
          ctx.toast((e && e.message) || '清不掉', 'err');
        });
      });

      function resetLibArm() {
        if (libTimer) { clearTimeout(libTimer); libTimer = null; }
        libArmed = false;
        libBtn.textContent = '清空图库（只删图片本身）';
        libBtn.classList.remove('is-armed');
      }

      var libRow = h('div', 'btn-row');
      libRow.appendChild(libBtn);
      gLib.card.appendChild(libRow);

      /* -------------------------- 危险操作 -------------------------- */

      var g3 = group('危险操作', '清除后聊天记录和 API 配置会一起消失，无法恢复。清除前先导出备份。');

      var armed = false;
      var armTimer = null;

      var delBtn = button('清除全部数据', 'danger', function () {
        if (!armed) {
          armed = true;
          delBtn.textContent = '再点一次，确认清除';
          delBtn.classList.add('is-armed');
          armTimer = setTimeout(resetArm, 4000);
          return;
        }
        resetArm();
        store.clearAll();
        /* 图库也要一起清 —— 只清 localStorage 的话，那些 blob 会永远
           留在 IndexedDB 里（记录都没了，谁也找不回它们）。 */
        if (Sleepy.media) {
          Sleepy.media.clear().then(function () {
            ctx.toast('已清除，正在刷新…', 'ok');
            setTimeout(function () { global.location.reload(); }, 700);
          }, function () {
            ctx.toast('记录清了，但图库没清干净', 'warn');
            setTimeout(function () { global.location.reload(); }, 1200);
          });
          return;
        }
        ctx.toast('已清除，正在刷新…', 'ok');
        setTimeout(function () { global.location.reload(); }, 700);
      });

      function resetArm() {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        armed = false;
        delBtn.textContent = '清除全部数据';
        delBtn.classList.remove('is-armed');
      }

      var btnRow = h('div', 'btn-row');
      btnRow.appendChild(delBtn);
      g3.card.appendChild(btnRow);
      body.appendChild(g3.wrap);

      body.appendChild(h('p', 'set-foot',
        '所有数据只存在这台设备上，不会上传到任何服务器。'));

      function refresh() {
        var u = store.usage();
        setRowValue(rowSize, fmtBytes(u.bytes));
        setRowValue(rowCount, u.keys + ' 项');

        var err = store.lastError();
        if (err && err.type === 'write') {
          setRowValue(rowState, '上次写入失败');
          if (err.message) rowState.title = err.message;
        } else {
          setRowValue(rowState, '正常');
        }

        /* 图库那三个数是异步查的（要开一次 IndexedDB），先占个位 */
        var m = Sleepy.media;
        if (!m) { libUnavailable('这台设备没有 IndexedDB'); return; }
        setRowValue(rowLibSize, '…');
        setRowValue(rowLibState, '…');
        setRowValue(rowLibCount, '…');
        m.available().then(function (yes) {
          if (!yes) { libUnavailable('用不了（无痕模式，或浏览器禁了）'); return; }
          setRowValue(rowLibState, 'IndexedDB（只在本机）');
          return m.usage().then(function (r) {
            setRowValue(rowLibSize, fmtBytes(r.bytes));
            setRowValue(rowLibCount, r.count + ' 张');
          });
        });
      }

      function libUnavailable(why) {
        setRowValue(rowLibState, why);
        setRowValue(rowLibSize, '—');
        setRowValue(rowLibCount, '—');
      }

      function doExport() {
        var payload = store.exportAll();
        var text = JSON.stringify(payload, null, 2);
        var ok = downloadText(FILE_PREFIX + '-' + stamp() + '.json', text, 'application/json');
        if (ok) ctx.toast('已导出 · ' + fmtBytes(store.usage().bytes), 'ok');
        else ctx.toast('导出失败：浏览器拦下了下载', 'err');
        refresh();
      }

      refresh();

      ctx.setActions([{
        label: '导出',
        kind: 'primary',
        onClick: function () { doExport(); }
      }]);
    },
    onShow: function (ctx) { /* 体积在 render 里算过一次，返回时无需重算 */ }
  });

})(window);
