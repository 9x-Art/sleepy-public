/* ============================================================
   repo-core.js — 设定仓库数据层（Sleepy.repo，P0）

   方案：docs/方案-设定仓库-v1.md。
   红线：设定包正文只在 user 与 R2 之间直传；本文件只管打包/拆包/
   门牌/账目 API。锁级 P0 只有 open（盲盒加密 P1 上）。

   键（**设备级**，不进岛章/删房名单——仓库跨岛跨设备）：
     repoCfg      { base }            仓库服务地址（部署 Worker 后填）
     repoGates    [code]              我进过的门牌
     repoGateName {code:name}         门牌名缓存
     repoToken    {token}             作者令牌（丢 = 无法管理自己上架的件）
     repoDownloads [{id,manifest,at}] 下载记录（导入向导从这里取包）

   manifest（发布/下载的单位）：
     { v:1, type:'char'|'island', gate, title, author, lock, version,
       items:[{ kind:'char'|'worldbook'|'book'|'theme'|'meta',
                lock:'open', name, url, data }] }
     头像/封面一律 URL（url 字段），媒体不进包。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var KEYS = ['repoCfg', 'repoGates', 'repoGateName', 'repoToken', 'repoDownloads', 'repoMine'];
  var MAX_SIZE = 5 * 1024 * 1024;

  /* ★ 官方仓库地址：**烤在这里**，所有 user 开箱即用，不在页面上填。
     Worker 部署后把域名填进 DEFAULT_BASE 即可（repoCfg.base 留作覆盖
     通道，页面不暴露）。 */
  var DEFAULT_BASE = 'https://sleepy-repo.2383444931.workers.dev';

  function get(k, d) { var v = store.get(k); return v === null || v === undefined ? d : v; }
  function set(k, v) { store.set(k, v); }

  function base() {
    return String((get('repoCfg', {}) || {}).base || DEFAULT_BASE).replace(/\/+$/, '');
  }

  /* ---------------- 打包 ---------------- */

  /* 角色卡sanitize：媒体引用清掉（换 URL），关系字段保留 */
  function cleanChar(c, url) {
    var out = JSON.parse(JSON.stringify(c));
    out.avatar = '';                       /* 本地 media 引用不进包 */
    out.avatarUrl = url || '';
    delete out.__roomCache;
    return out;
  }

  function packChar(charId, opts) {
    opts = opts || {};
    var c = core.findChar(charId);
    if (!c) throw new Error('找不到这个角色');
    return {
      v: 1, type: 'char', gate: opts.gate || '',
      title: (c.name || '未命名角色'),
      author: opts.author || '', lock: 'open', version: 1,
      items: [{ kind: 'char', lock: 'open', name: c.name || '', url: opts.avatarUrl || '',
        data: cleanChar(c, opts.avatarUrl) }]
    };
  }

  /* 整岛包：chars + worldbooks + 以身入局（档案盒+导入文本）+ 美化 + 岛元信息。
     不带：聊天/朋友圈/日记/照片/马甲/API。 */
  function packIsland(sid, opts) {
    opts = opts || {};
    var sb = core.findSandbox(sid);
    if (!sb) throw new Error('找不到这座岛');
    var items = [];
    var parts = opts.parts || {};
    if (parts.meta !== false) {
      items.push({ kind: 'meta', lock: 'open', name: '岛的基础信息', url: opts.avatarUrl || '',
        data: { kind: sb.kind, name: sb.name, cover: '', bg: sb.bg || '', desc: sb.desc || '' } });
    }
    if (parts.chars !== false) {
      core.charsOfSandbox(sid).forEach(function (c) {
        items.push({ kind: 'char', lock: 'open', name: c.name || '', url: opts.avatarUrl || '',
          data: cleanChar(c, opts.avatarUrl) });
      });
    }
    if (parts.worldbook !== false) {
      (store.get('worldbooks') || []).forEach(function (wb) {
        if (!wb) return;
        /* 只带这座岛相关的：全局书 + 挂岛上角色的个人书 */
        var related = !wb.characterId ||
          sb.charIds.indexOf(wb.characterId) >= 0;
        if (!related) return;
        items.push({ kind: 'worldbook', lock: 'open', name: wb.name || '世界书',
          url: '', data: wb });
      });
    }
    if (parts.book !== false) {
      var boxes = (store.get('bookBoxes') || []).filter(function (b) {
        return b && b.sandboxId === sid;
      });
      var imps = store.get('bookImports') || [];
      boxes.forEach(function (b) {
        var imp = b.importId ? imps.filter(function (r) { return r && r.id === b.importId; })[0] : null;
        items.push({ kind: 'book', lock: 'open', name: b.title || '世界档案',
          url: '', data: { box: b, import: imp || null } });
      });
    }
    if (parts.theme !== false) {
      var ap = store.get('appearance');
      if (ap) items.push({ kind: 'theme', lock: 'open', name: '美化（外观）', url: '',
        data: ap });
    }
    return {
      v: 1, type: 'island', gate: opts.gate || '',
      title: opts.title || (sb.name || '未命名岛') + ' · 整岛包',
      author: opts.author || '', lock: 'open', version: 1,
      items: items
    };
  }

  /* ---------------- 发布 / 下载 ---------------- */

  function publish(manifest, cb) {
    var b = base();
    if (!b) { cb({ ok: false, message: '还没接上仓库服务（设置里填仓库地址）' }); return; }
    manifest.gate = manifest.gate || (get('repoGates', [])[0] || '');
    var text = JSON.stringify(manifest);
    if (text.length > MAX_SIZE) { cb({ ok: false, message: '超过单件 5MB，拆件上架' }); return; }
    var token = (get('repoToken', {}) || {}).token || '';
    global.fetch(b + '/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Repo-Token': token },
      body: text
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok && r.authorToken) set('repoToken', { token: r.authorToken });
      cb(r);
    }, function (e) { cb({ ok: false, message: '发布失败：' + ((e && e.message) || '网络不通') }); });
  }

  function verifyGate(code, cb) {
    var b = base();
    if (!b) { cb({ ok: false, message: '还没接上仓库服务' }); return; }
    global.fetch(b + '/gate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) {
        var gates = get('repoGates', []);
        if (gates.indexOf(code) < 0) { gates.push(code); set('repoGates', gates); }
        var names = get('repoGateName', {}); names[code] = r.name; set('repoGateName', names);
      }
      cb(r);
    }, function (e) { cb({ ok: false, message: '网络不通：' + ((e && e.message) || e) }); });
  }

  function shelf(code, cb) {
    var b = base();
    if (!b) { cb({ ok: false, message: '还没接上仓库服务' }); return; }
    global.fetch(b + '/shelf?gate=' + encodeURIComponent(code))
      .then(function (r) { return r.json(); }).then(cb,
        function (e) { cb({ ok: false, message: '网络不通：' + ((e && e.message) || e) }); });
  }

  function downloadItem(id, gate, cb) {
    var b = base();
    if (!b) { cb({ ok: false, message: '还没接上仓库服务' }); return; }
    global.fetch(b + '/item/' + encodeURIComponent(id) + '?gate=' + encodeURIComponent(gate))
      .then(function (r) { return r.json(); }).then(function (manifest) {
        if (!manifest || !manifest.items) { cb({ ok: false, message: '包体不对' }); return; }
        var list = get('repoDownloads', []);
        list.push({ id: id, gate: gate, manifest: manifest, at: Date.now() });
        set('repoDownloads', list.slice(-100));
        cb({ ok: true, manifest: manifest });
      }, function (e) { cb({ ok: false, message: '下载失败：' + ((e && e.message) || e) }); });
  }

  function unpublish(id, cb) {
    var b = base();
    var token = (get('repoToken', {}) || {}).token || '';
    if (!b || !token) { cb({ ok: false, message: '还没有仓库服务或作者令牌' }); return; }
    global.fetch(b + '/item/' + encodeURIComponent(id), {
      method: 'DELETE', headers: { 'X-Repo-Token': token }
    }).then(function (r) { return r.json(); }).then(cb,
      function (e) { cb({ ok: false, message: String((e && e.message) || e) }); });
  }

  /* ---------------- 门牌识别 ---------------- */

  /* 从任意文本里抠出门牌码：链接 (?g=xxx) 或裸口令（4~10 位字母数字） */
  function parseGateText(text) {
    var s = String(text || '');
    var m = s.match(/[?&]g=([A-Za-z0-9]{4,12})/);
    if (m) return m[1];
    m = s.match(/(?:^|[\s：:，,「【])([A-Za-z0-9]{4,10})(?=$|[\s：:，,」】])/);
    return m ? m[1] : '';
  }

  /* ---------------- 导入 ---------------- */

  function newId(p) { return (p || 'rp') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* 单角色卡：进当前激活岛 */
  function importChar(manifest, cb) {
    var sb = core.activeSandbox();
    if (!sb) { cb({ ok: false, message: '先进入一座岛，角色卡才有地方落' }); return; }
    var charIds = [];
    var errors = [];
    manifest.items.forEach(function (it) {
      if (it.kind !== 'char' || !it.data) return;
      var data = JSON.parse(JSON.stringify(it.data));
      data.id = newId('ch');
      data.avatarUrl = it.url || data.avatarUrl || '';
      data.avatar = '';
      try {
        var c = core.upsertChar(data);
        charIds.push(c.id);
      } catch (e) { errors.push(String(e.message || e)); }
    });
    if (charIds.length) {
      var ids = (sb.charIds || []).concat(charIds);
      core.setSandboxChars(sb.id, ids);
    }
    cb({ ok: !errors.length || charIds.length > 0,
      message: charIds.length ? '角色进了「' + sb.name + '」' : (errors[0] || '没导出东西') });
  }

  /* 整岛包：生成新岛。choices: { theme:'mine'|'pack', worldbook:'mine'|'pack', book:'pack' } */
  function importIsland(manifest, choices, cb) {
    choices = choices || {};
    var meta = null;
    manifest.items.forEach(function (it) { if (it.kind === 'meta' && it.data) meta = it.data; });
    var sb = core.createSandbox((meta && meta.kind) || 'isle',
      (meta && meta.name) || manifest.title.replace(/ · 整岛包$/, ''));
    var charMap = {};   /* 旧 charId → 新 charId（世界书挂靠要用） */
    var errs = [];
    manifest.items.forEach(function (it) {
      try {
        if (it.kind === 'char' && it.data) {
          var data = JSON.parse(JSON.stringify(it.data));
          var oldId = data.id;
          data.id = newId('ch');
          data.avatar = '';
          data.avatarUrl = it.url || data.avatarUrl || '';
          var c = core.upsertChar(data);
          charMap[oldId] = c.id;
        }
      } catch (e) { errs.push('角色：' + String(e.message || e)); }
    });
    core.setSandboxChars(sb.id, Object.keys(charMap).map(function (k) { return charMap[k]; }));

    if (choices.worldbook === 'pack') {
      var wbs = store.get('worldbooks') || [];
      manifest.items.forEach(function (it) {
        if (it.kind !== 'worldbook' || !it.data) return;
        var wb = JSON.parse(JSON.stringify(it.data));
        wb.id = newId('wb');
        if (wb.characterId && charMap[wb.characterId]) wb.characterId = charMap[wb.characterId];
        else if (wb.scope === 'personal') return;   /* 挂靠的角色没进包 → 跳过个人书 */
        wbs.push(wb);
      });
      store.set('worldbooks', wbs);
    }

    manifest.items.forEach(function (it) {
      if (it.kind !== 'book' || !it.data) return;
      try {
        var d = it.data;
        var impId = null;
        if (d.import) {
          var imp = JSON.parse(JSON.stringify(d.import));
          imp.id = newId('bi');
          imp.sandboxId = sb.id;                     /* 重新盖岛章 */
          var imps = store.get('bookImports') || [];
          imps.push(imp);
          store.set('bookImports', imps);
          impId = imp.id;
        }
        var box = JSON.parse(JSON.stringify(d.box));
        box.id = newId('book-box');
        box.sandboxId = sb.id;
        box.importId = impId;
        var boxes = store.get('bookBoxes') || [];
        boxes.push(box);
        store.set('bookBoxes', boxes);
      } catch (e) { errs.push('档案：' + String(e.message || e)); }
    });

    if (choices.theme === 'pack') {
      manifest.items.forEach(function (it) {
        if (it.kind === 'theme' && it.data) store.set('appearance', it.data);
      });
    }

    cb({ ok: true, sandboxId: sb.id,
      message: '新岛「' + sb.name + '」落好了' + (errs.length ? '（有 ' + errs.length + ' 件没导上：' + errs[0] + '）' : '') });
  }

  Sleepy.repo = {
    KEYS: KEYS,
    base: base,
    cfg: function () { return get('repoCfg', {}); },
    setCfg: function (c) { set('repoCfg', c || {}); },
    gates: function () { return get('repoGates', []); },
    gateName: function (code) { return (get('repoGateName', {})[code]) || ''; },
    authorToken: function () { return (get('repoToken', {}) || {}).token || ''; },
    downloads: function () { return get('repoDownloads', []); },
    mine: function () { return get('repoMine', []); },
    recordMine: function (rec) {
      var list = get('repoMine', []);
      list.push(rec);
      set('repoMine', list.slice(-200));
    },
    packChar: packChar,
    packIsland: packIsland,
    publish: publish,
    verifyGate: verifyGate,
    shelf: shelf,
    downloadItem: downloadItem,
    unpublish: unpublish,
    parseGateText: parseGateText,
    importChar: importChar,
    importIsland: importIsland
  };

})(window);
