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

  var KEYS = ['repoCfg', 'repoGates', 'repoGateName', 'repoToken', 'repoDownloads', 'repoMine', 'repoThemes', 'license'];
  var MAX_SIZE = 5 * 1024 * 1024;

  /* ---------------- 美化件载荷（sleepy-theme-v1，2026-10-22 P0 修复） ----------------
     旧版 packIsland 把【整个外观存档】塞进包、导入时整档 set 回去 ——
     会冲掉领取者的全局外观、所有岛的覆盖和 appOverrides，且全局生效而不是
     落到新岛。改为**只带可移植的最小集**：
       { fmt:'sleepy-theme-v1', theme:'配色id', desk:{wall,icons,large} }
     · 「岛覆盖 > 全局」：打包取「原岛生效中的样子」（岛覆盖有就用岛覆盖）；
     · 自定义壁纸（wall:'custom'+wallMediaId）引用**本机媒体**，不进包 → 落 auto；
     · 字号/动效/字体/正文字色是全局性的（外观页口径），不跟岛走，也不进包。 */
  var THEME_FMT = 'sleepy-theme-v1';
  var THEME_DESK_KEYS = ['wall', 'icons', 'large'];
  var THEME_DESK_DEFAULT = { wall: 'auto', icons: 'glass', large: false };

  /* 原岛 sid 生效中的美化载荷。sid 空 = 纯全局样子。 */
  function themePayloadOf(sid) {
    var a = store.get('appearance') || {};
    var isl = (sid && a.desktop && a.desktop.islands) ? (a.desktop.islands[sid] || null) : null;
    var g = (a.desktop && a.desktop.global) || {};
    var out = { fmt: THEME_FMT, theme: '', desk: {} };
    THEME_DESK_KEYS.forEach(function (k) {
      var v = isl && isl[k] !== undefined ? isl[k] : (g[k] !== undefined ? g[k] : THEME_DESK_DEFAULT[k]);
      out.desk[k] = v;
    });
    out.theme = (isl && isl.theme) || a.theme || '';
    if (out.desk.wall === 'custom') { out.desk.wall = 'auto'; }   /* 本机媒体壁纸不进包 */
    return out;
  }

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
      cover: opts.cover || '',
      visible: !!opts.visible,
      items: [{ kind: 'char', lock: 'open', name: c.name || '', url: opts.avatarUrl || '',
        data: cleanChar(c, opts.avatarUrl) }]
    };
  }

  /* 食单单件：只带一本世界书（2026-10-11 用户：世界书要能单独上传）。
     个人书挂靠的角色不在下载者设备上 → 导入时转全局书。 */
  function packWorldbook(wbId, opts) {
    opts = opts || {};
    var wb = (store.get('worldbooks') || []).filter(function (w) {
      return w && w.id === wbId;
    })[0];
    if (!wb) throw new Error('找不到这本世界书');
    return {
      v: 1, type: 'worldbook', gate: opts.gate || '',
      title: wb.name || '未命名世界书',
      author: opts.author || '', lock: 'open', version: 1,
      cover: opts.cover || '',
      visible: !!opts.visible,
      items: [{ kind: 'worldbook', lock: 'open', name: wb.name || '世界书', url: '',
        data: JSON.parse(JSON.stringify(wb)) }]
    };
  }

  /* 摆盘单件：单独分享一套美化（2026-10-22 用户：美化也是单独分享的）。
     data = themePayloadOf(sbId) —— 打包「这座岛生效中的样子」。 */
  function packTheme(sbId, opts) {
    opts = opts || {};
    var sb = core.findSandbox(sbId);
    if (!sb) throw new Error('找不到这座岛');
    return {
      v: 1, type: 'theme', gate: opts.gate || '',
      title: opts.title || (sb.name || '这座岛') + ' · 美化',
      author: opts.author || '', lock: 'open', version: 1,
      cover: opts.cover || '',
      visible: !!opts.visible,
      items: [{ kind: 'theme', lock: 'open', name: '美化（外观）', url: '',
        data: themePayloadOf(sbId) }]
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
        if (wb.sealed) return;   /* 暗铺书不二次传播（作者锁起来的内容） */
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
      items.push({ kind: 'theme', lock: 'open', name: '美化（外观）', url: '',
        data: themePayloadOf(sid) });   /* P0 修：只带最小可移植集，不再整档进包 */
    }
    return {
      v: 1, type: 'island', gate: opts.gate || '',
      title: opts.title || (sb.name || '未命名岛') + ' · 整岛包',
      author: opts.author || '', lock: 'open', version: 1,
      cover: opts.cover || '',
      visible: !!opts.visible,
      items: items
    };
  }

  /* ---------------- 明厨 / 暗铺（2026-10-11 条目级锁 v2 语义） ----------------
     明厨 = 条目公开。暗铺两档：
     · 暗号留空 → **可用不可看**：混淆锁（内置 key），导入后自动解开并打
       hidden 标 —— 世界书照常注入但列表里看不见、美化照常生效但样式代码
       不给看；包文件里也没有明文。
     · 填了暗号 → **需对暗号**：用暗号派生锁，导入时对上才能用（作者定向分享）。
     角色件没有「可用不可看」档（人设落在本地 store，编辑页看得到 = 名存实亡），
     暗铺角色一律 needCode。强度口径：防白嫖/防顺手翻包，不防定向攻击。 */
  var HIDDEN_KEY = 'yushanfang-hidden-v1';
  function keyStream(secret, len) {
    var seed = 0x811c9dc5;
    var s = String(secret || '');
    for (var i = 0; i < s.length; i++) {
      seed ^= s.charCodeAt(i);
      seed = (seed * 0x01000193) >>> 0;
    }
    var out = new Uint8Array(len);
    var x = seed || 1;
    for (var j = 0; j < len; j++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      out[j] = x & 0xff;
    }
    return out;
  }
  function b64FromBytes(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function bytesFromB64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /* 手写 UTF-8 编解码：smoke 的 vm 沙箱没有 TextEncoder/TextDecoder */
  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function utf8Decode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); i++; }
      else if (b < 0xe0) { out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
      else if (b < 0xf0) {
        out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3;
      } else {
        var cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
        out += String.fromCharCode(cp); i += 4;
      }
    }
    return out;
  }
  function xorBytes(bytes, secret) {
    var ks = keyStream(secret, bytes.length);
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ ks[i];
    return out;
  }
  function lockItem(item, secret) {
    if (item.lock === 'locked' || item.enc) return;
    var plain = utf8Encode(JSON.stringify(item.data || {}));
    item.enc = b64FromBytes(xorBytes(plain, secret));
    delete item.data;
    if (item.url) { item._url = item.url; delete item.url; }  /* 头像 URL 也一起藏 */
    item.lock = 'locked';
  }
  function unlockItem(item, secret) {
    if (item.lock !== 'locked' || !item.enc) return true;
    try {
      var plain = xorBytes(bytesFromB64(item.enc), secret);
      item.data = JSON.parse(utf8Decode(plain));
      delete item.enc;
      if (item._url) { item.url = item._url; delete item._url; }
      item.lock = 'open';
      return true;
    } catch (e) { return false; }
  }
  /* 发布前上锁：lockedIdx = 要上锁的 items 下标数组；secret 可空 ——
     空 = 可用不可看（混淆锁），填了 = 需对暗号。所有件同一口径
     （2026-10-11 用户：角色「干脆就给看」，靠领取条件约束）。
     condition = 领取条件（'none'|'repo'|'like'|'comment'），落 manifest.condition，
     详情页/领取时展示；实际校验等席间（评论/repo）开张后生效。 */
  function applyLocks(manifest, lockedIdx, secret, condition) {
    if (!lockedIdx.length) { manifest.access = 'open'; manifest.lock = 'open'; return manifest; }
    var needCode = !!secret;
    lockedIdx.forEach(function (i) {
      var it = manifest.items[i];
      if (!it) return;
      if (needCode) it.needCode = true;
      else delete it.needCode;
      lockItem(it, needCode ? secret : HIDDEN_KEY);
    });
    var anyNeedCode = manifest.items.some(function (it) { return it.needCode; });
    manifest.access = anyNeedCode ? 'gated' : 'sealed';
    manifest.lock = anyNeedCode ? 'gated' : 'sealed';
    manifest.condition = condition || 'none';
    if (needCode) {
      manifest.secretHash = keyStream(secret, 8).reduce(function (a, b) {
        return a + (b < 16 ? '0' : '') + b.toString(16);
      }, '');
    }
    return manifest;
  }
  /* 导入前解锁：混淆件自动解开（打 wasHidden 标），暗号件要 secret 才解。
     返回解开件数。 */
  function unlockItems(manifest, secret) {
    var n = 0;
    manifest.items.forEach(function (it) {
      if (it.lock !== 'locked' || !it.enc) return;
      if (it.needCode) {
        if (secret && unlockItem(it, secret)) n++;
      } else if (unlockItem(it, HIDDEN_KEY)) {
        it.wasHidden = true;
        n++;
      }
    });
    return n;
  }
  function lockedCount(manifest) {
    return manifest.items.filter(function (it) { return it.lock === 'locked'; }).length;
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

  /* 公共铺面（免门牌；v2）：params = { type, q, sort }，sort: latest|hot */
  function publicShelf(params, cb) {
    params = params || {};
    var qs = [];
    if (params.type) qs.push('type=' + encodeURIComponent(params.type));
    if (params.q) qs.push('q=' + encodeURIComponent(params.q));
    if (params.sort) qs.push('sort=' + encodeURIComponent(params.sort));
    global.fetch(base() + '/public-shelf' + (qs.length ? '?' + qs.join('&') : ''), {
      method: 'GET'
    }).then(function (r) { return r.json(); }).then(cb,
      function (e) { cb({ ok: false, message: '公共铺面还没开张：' + ((e && e.message) || e) }); });
  }

  /* 作品详情元数据（包外信息，不含包体内容；v2） */
  function itemMeta(id, gate, cb) {
    var qs = gate ? '?gate=' + encodeURIComponent(gate) : '';
    global.fetch(base() + '/item/' + encodeURIComponent(id) + '/meta' + qs, {
      method: 'GET'
    }).then(function (r) { return r.json(); }).then(cb,
      function (e) { cb({ ok: false, message: '网络不通：' + ((e && e.message) || e) }); });
  }

  /* ---------------- 席间（评论/尝后感/点赞，v2.1） ---------------- */

  /* 设备号：点赞去重 + 领取条件记账的匿名凭证（设备级，不进岛章） */
  function deviceId() {
    var id = get('repoDeviceId', '');
    if (!id) {
      id = newId('dv');
      set('repoDeviceId', id);
    }
    return id;
  }
  function likedIds() { return get('repoLikedIds', []); }

  function likeItem(id, cb) {
    if (likedIds().indexOf(id) >= 0) { cb({ ok: false, message: '赞过了 —— 一个设备一票' }); return; }
    global.fetch(base() + '/item/' + encodeURIComponent(id) + '/like', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) {
        var list = likedIds();
        list.push(id);
        set('repoLikedIds', list.slice(-200));
      }
      cb(r);
    }, function (e) { cb({ ok: false, message: '网络不通：' + ((e && e.message) || e) }); });
  }

  function listComments(id, cb) {
    global.fetch(base() + '/item/' + encodeURIComponent(id) + '/comments', {
      method: 'GET'
    }).then(function (r) { return r.json(); }).then(cb,
      function (e) { cb({ ok: false, message: '网络不通：' + ((e && e.message) || e) }); });
  }

  /* kind: 'comment'（席间说一句）| 'repo'（尝后感） */
  function postComment(id, kind, body, cb) {
    /* ★ 2026-10-12 P0 修：原来是 `var c = cfg()` —— 闭包里没有 cfg 这个
       名字（导出面上的 cfg 是 api 对象的属性，不是函数内作用域），同步
       ReferenceError，席间两个入口必炸、发送按钮永远灰。
       配置入口与 base() 保持一致：repoCfg。profile.name 正是资料编辑器
       存的「铺子昵称」（page-repo.js 的 profile/saveProfile 写
       repoCfg.profile），修好即生效，不是兜底猜的。 */
    var c = get('repoCfg', {}) || {};
    global.fetch(base() + '/item/' + encodeURIComponent(id) + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: (c.profile && c.profile.name) || '无名食客',
        body: body, kind: kind, device: deviceId()
      })
    }).then(function (r) { return r.json(); }).then(cb,
      function (e) { cb({ ok: false, message: '网络不通：' + ((e && e.message) || e) }); });
  }

  function checkCondition(id, cb) {
    global.fetch(base() + '/item/' + encodeURIComponent(id) + '/condition?device=' +
      encodeURIComponent(deviceId()), {
      method: 'GET'
    }).then(function (r) { return r.json(); }).then(cb,
      function (e) { cb({ ok: false, message: '网络不通：' + ((e && e.message) || e) }); });
  }

  /* 作者席间消息（我名下件收到的评论/尝后感；v2.1） */
  function myInbox(cb) {
    var token = (get('repoToken', {}) || {}).token || '';
    if (!token) { cb({ ok: true, comments: [], likesTotal: 0 }); return; }
    global.fetch(base() + '/inbox', {
      method: 'GET', headers: { 'X-Repo-Token': token }
    }).then(function (r) { return r.json(); }).then(cb,
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

  /* 食单导入：世界书单件落库。挂靠角色不在本机 → 转全局书并说明。 */
  function importWorldbook(manifest, cb) {
    var added = [];
    var errs = [];
    manifest.items.forEach(function (it) {
      if (it.kind !== 'worldbook' || !it.data) return;
      try {
        var wb = JSON.parse(JSON.stringify(it.data));
        wb.id = newId('wb');
        if (it.wasHidden) wb.sealed = true;   /* 暗铺书：目录可见+条目内容锁，注入照常 */
        if (wb.characterId && !core.findChar(wb.characterId)) {
          /* 原挂靠角色不在这台设备 → 转全局书（个人书归挂靠本体的规矩不能破） */
          delete wb.characterId;
          wb.scope = 'global';
        }
        var wbs = store.get('worldbooks') || [];
        wbs.push(wb);
        store.set('worldbooks', wbs);
        added.push(wb.name || '未命名世界书');
      } catch (e) { errs.push(String(e.message || e)); }
    });
    cb({ ok: added.length > 0,
      message: added.length
        ? '《' + added.join('》《') + '》进了世界书' + (errs.length ? '（有件没导上）' : '')
        : (errs[0] || '包里没有能导的世界书') });
  }

  /* 美化载荷落档（2026-10-22 P0 修）：
     · target = 岛 id → 写**这座岛的覆盖**（appearance.desktop.islands[target]），
       全局档和其他岛的覆盖一个字都不碰；
     · target = 'global' → 写全局（配色 + desktop.global）；
     · 旧格式兼容：老包 theme 件是没有 fmt 的整档外观 —— 只抽取全局侧的
       配色与桌面键，islands/appOverrides 一律不采（不再有整档覆盖这回事）。
     落完档调 apply()，导入即生效，不用重开 App。 */
  function applyThemePayload(data, target) {
    var d = data || {};
    var a = store.get('appearance') || {};
    var theme = '', desk = {};
    if (d.fmt === THEME_FMT) {
      theme = d.theme || '';
      desk = d.desk || {};
    } else {
      /* 旧整档：抽全局侧。老包里 custom 壁纸同样落 auto。 */
      theme = d.theme || '';
      var g = (d.desktop && d.desktop.global) || {};
      THEME_DESK_KEYS.forEach(function (k) {
        desk[k] = g[k] !== undefined ? g[k] : THEME_DESK_DEFAULT[k];
      });
      if (desk.wall === 'custom') desk.wall = 'auto';
    }
    if (target === 'global') {
      if (theme) a.theme = theme;
      a.desktop = a.desktop || {};
      a.desktop.global = a.desktop.global || {};
      THEME_DESK_KEYS.forEach(function (k) {
        if (desk[k] !== undefined) a.desktop.global[k] = desk[k];
      });
    } else {
      var sb = core.findSandbox(target);
      if (!sb) return { ok: false, message: '找不到要应用的岛' };
      a.desktop = a.desktop || {};
      a.desktop.islands = a.desktop.islands || {};
      var ov = {};
      if (theme) ov.theme = theme;
      THEME_DESK_KEYS.forEach(function (k) {
        ov[k] = desk[k] !== undefined ? desk[k] : THEME_DESK_DEFAULT[k];
      });
      a.desktop.islands[target] = ov;
    }
    store.set('appearance', a);
    /* DOM 层收尾：apply 挂了不该连坐数据层（冒烟 vm 里没有真 DOM） */
    try { if (Sleepy.appearance && Sleepy.appearance.apply) Sleepy.appearance.apply(); } catch (e) { /* 视图层 */ }
    return { ok: true };
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
        if (it.wasHidden) wb.sealed = true;   /* 暗铺书：目录可见+条目内容锁，注入照常 */
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
        if (it.kind === 'theme' && it.data) {
          var r = applyThemePayload(it.data, sb.id);   /* P0 修：只应用到新岛 */
          if (!r.ok) errs.push('美化：' + r.message);
        }
      });
    }

    cb({ ok: true, sandboxId: sb.id,
      message: '新岛「' + sb.name + '」落好了' + (errs.length ? '（有 ' + errs.length + ' 件没导上：' + errs[0] + '）' : '') });
  }

  /* ---------------- 摆盘单件导入（2026-10-22）----------------
     mode: 'preset'（存进我的美化预设，不马上用）
         | 'global'（应用为所有岛的默认）
         | 'island'（应用到当前激活岛）。 */
  function themePresets() { return get('repoThemes', []); }

  function saveThemePreset(name, data) {
    var list = themePresets();
    list.push({ id: newId('th'), name: name || '未命名美化', data: data, at: Date.now() });
    set('repoThemes', list.slice(-50));
    return list[list.length - 1];
  }

  function deleteThemePreset(id) {
    set('repoThemes', themePresets().filter(function (p) { return p && p.id !== id; }));
  }

  function importTheme(manifest, mode, cb) {
    var it = null;
    (manifest.items || []).forEach(function (x) {
      if (x.kind === 'theme' && x.data && !it) it = x;
    });
    if (!it) { cb({ ok: false, message: '包里没有美化件' }); return; }
    if (mode === 'preset') {
      var p = saveThemePreset(manifest.title, it.data);
      cb({ ok: true, message: '「' + p.name + '」存进美化预设了 —— 外观页里随时可用' });
      return;
    }
    var target = mode === 'global' ? 'global' : (core.activeSandbox() || {}).id;
    if (!target) { cb({ ok: false, message: '先进一座岛，或者选「应用为全局默认」' }); return; }
    var r = applyThemePayload(it.data, target);
    cb(r.ok
      ? { ok: true, message: mode === 'global'
          ? '美化应用为全局默认了'
          : '美化应用到「' + core.findSandbox(target).name + '」了' }
      : r);
  }

  /* ---------------- 火候单件（预设配置，2026-10-22）----------------
     预设系统的可分享面 = presetEngine 档的三块：
       disabled（关掉的内置卡）/ overrides（槽位覆盖文本）/ custom（自定义注入卡）。
     载荷只带这三块的最小集：卡的 id/时间戳不进包（导入重新发）；
     引擎开关 useEngine / developerMode / inspect 是**设备自身状态**，不进包。 */
  var PRESET_FMT = 'sleepy-preset-v1';

  function presetPayloadOf() {
    var c = store.get('presetEngine') || {};
    var disabled = Object.keys(c.disabled || {}).filter(function (k) { return c.disabled[k]; });
    var overrides = {};
    Object.keys(c.overrides || {}).forEach(function (k) {
      if (c.overrides[k]) overrides[k] = c.overrides[k];
    });
    var custom = (c.custom || []).map(function (cc) {
      var out = { title: String(cc.title || '未命名注入'), body: String(cc.body || '') };
      if (cc.group) out.group = true;   /* 群聊可用标记照带（口径同 engine） */
      return out;
    });
    return { fmt: PRESET_FMT, disabled: disabled, overrides: overrides, custom: custom };
  }

  function packPreset(opts) {
    opts = opts || {};
    var data = presetPayloadOf();
    var n = data.disabled.length + Object.keys(data.overrides).length + data.custom.length;
    if (!n) throw new Error('这套预设是空的 —— 先去预设页配点东西（关几张内置卡 / 写自定义注入）');
    return {
      v: 1, type: 'preset', gate: opts.gate || '',
      title: opts.title || '预设 · 火候',
      author: opts.author || '', lock: 'open', version: 1,
      cover: opts.cover || '',
      visible: !!opts.visible,
      items: [{ kind: 'preset', lock: 'open', name: '预设（火候）', url: '', data: data }]
    };
  }

  /* 预设落档。mode: 'merge'（叠加：卡追加、关的卡只增不减、覆盖逐槽盖）
                | 'replace'（整套装上：三块全换成包里的 —— 会清掉自己原来的卡）。
     返回统计给向导念。 */
  function applyPresetPayload(d, mode) {
    if (!d || d.fmt !== PRESET_FMT) return { ok: false, message: '预设件格式不对' };
    var c = store.get('presetEngine') || {};
    if (!c.overrides) c.overrides = {};
    if (!c.disabled) c.disabled = {};
    if (!c.custom) c.custom = [];
    var newCard = function (src) {
      return { id: 'cu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: String(src.title || '未命名注入'), body: String(src.body || ''), at: Date.now(),
        group: src.group ? true : undefined };
    };
    var stats = { cards: 0, off: 0, ov: 0 };
    if (mode === 'replace') {
      c.disabled = {};
      c.overrides = {};
      c.custom = [];
    }
    (d.disabled || []).forEach(function (k) {
      if (k && !c.disabled[k]) { c.disabled[k] = true; stats.off++; }
    });
    Object.keys(d.overrides || {}).forEach(function (k) {
      if (d.overrides[k]) { c.overrides[k] = d.overrides[k]; stats.ov++; }
    });
    (d.custom || []).forEach(function (cc) {
      c.custom.push(newCard(cc)); stats.cards++;
    });
    store.set('presetEngine', c);
    return { ok: true, stats: stats };
  }

  function importPreset(manifest, mode, cb) {
    var it = null;
    (manifest.items || []).forEach(function (x) {
      if (x.kind === 'preset' && x.data && !it) it = x;
    });
    if (!it) { cb({ ok: false, message: '包里没有预设件' }); return; }
    var d = it.data || {};
    var n = (d.disabled || []).length + Object.keys(d.overrides || {}).length + (d.custom || []).length;
    if (!n) { cb({ ok: false, message: '这套预设是空的，没什么可装' }); return; }
    var r = applyPresetPayload(it.data, mode === 'replace' ? 'replace' : 'merge');
    if (!r.ok) { cb(r); return; }
    var s = r.stats;
    cb({ ok: true, message: '预设装好了：' +
      (s.cards ? '自定义注入 +' + s.cards + ' ' : '') +
      (s.off ? '内置卡关 ' + s.off + ' 张 ' : '') +
      (s.ov ? '槽位覆盖 ' + s.ov + ' 处' : '') +
      (s.cards + s.off + s.ov === 0 ? '（包里的都已在用，没动）' : '') });
  }

  /* ---------------- 入席单件（以身入局世界档案，2026-10-22）----------------
     与整岛包的 book 件同构：{ box, import } —— 盒 + 章节全文。
     差异：单件是「分享一本书的世界」，领取者从零开局 →
     status 归 empty、媒体引用（coverRef/sceneRefs，本机 mediaId）不进包。 */
  function cleanBookData(boxId) {
    var box = (store.get('bookBoxes') || []).filter(function (b) {
      return b && b.id === boxId;
    })[0];
    if (!box) throw new Error('找不到这个档案盒');
    var imp = box.importId
      ? (store.get('bookImports') || []).filter(function (r) { return r && r.id === box.importId; })[0]
      : null;
    var boxOut = JSON.parse(JSON.stringify(box));
    boxOut.coverRef = null;                 /* 本机媒体引用不进包（媒体红线同头像） */
    boxOut.sceneRefs = [];
    delete boxOut.sandboxId;                /* 岛章不进包 —— 导入时重新盖 */
    var impOut = null;
    if (imp) {
      impOut = JSON.parse(JSON.stringify(imp));
      delete impOut.sandboxId;
    }
    return { box: boxOut, import: impOut };
  }

  function packBook(boxId, opts) {
    opts = opts || {};
    var d = cleanBookData(boxId);
    return {
      v: 1, type: 'book', gate: opts.gate || '',
      title: opts.title || d.box.title || '未命名世界',
      author: opts.author || '', lock: 'open', version: 1,
      cover: opts.cover || '',
      visible: !!opts.visible,
      items: [{ kind: 'book', lock: 'open', name: d.box.title || '世界档案', url: '', data: d }]
    };
  }

  /* 领取：进**当前激活岛**（同角色卡口径），重新盖岛章 + 发新 id，
     章节全文原样带过来，status 归 empty（从零开局），媒体引用清零。 */
  function importBook(manifest, cb) {
    var sb = core.activeSandbox();
    if (!sb) { cb({ ok: false, message: '先进入一座岛，世界档案才有地方落' }); return; }
    var added = [];
    var errs = [];
    (manifest.items || []).forEach(function (it) {
      if (it.kind !== 'book' || !it.data) return;
      try {
        var d = it.data;
        var impId = null;
        if (d.import && d.import.chapters) {
          var imp = JSON.parse(JSON.stringify(d.import));
          imp.id = newId('bi');
          imp.sandboxId = sb.id;              /* 重新盖岛章 */
          var imps = store.get('bookImports') || [];
          imps.push(imp);
          store.set('bookImports', imps);
          impId = imp.id;
        }
        var box = JSON.parse(JSON.stringify(d.box));
        box.id = newId('book-box');
        box.sandboxId = sb.id;
        box.importId = impId;
        box.status = 'empty';                 /* 领取者从零开局 */
        box.coverRef = null;
        box.sceneRefs = [];
        var boxes = store.get('bookBoxes') || [];
        boxes.push(box);
        store.set('bookBoxes', boxes);
        added.push(box.title || '世界档案');
      } catch (e) { errs.push(String(e.message || e)); }
    });
    cb({ ok: added.length > 0,
      message: added.length
        ? '《' + added.join('》《') + '》进了「' + sb.name + '」的档案架' + (errs.length ? '（有件没导上）' : '')
        : (errs[0] || '包里没有能导的世界档案') });
  }

  /* ==================== 授权层（账密系统，方案-账密系统-v2，2026-10-21）====================

     激活码即账号（发售路线 §三/§十）：发码页领码（QQ 记账）→ App 激活设密码
     → 换设备 QQ+密码登录 → 设备上限 3 台、可踢、自助解绑。
     纪律：**账号与存储解耦** —— 这里绝不含任何备份/同步逻辑；
     游玩数据永不经此（worker 同一条红线）。

     键：license {token, qq, lastVerifiedAt} —— 已登记 store 的
     DEVICE_LOCAL_KEYS（设备本机登录态，导出/导入/快照都不带）。 */

  function licGet() { return get('license', null) || null; }
  function licSet(v) { set('license', v || null); }

  function licRequest(path, method, body, cb) {
    var lic = licGet();
    var headers = { 'Content-Type': 'application/json' };
    if (lic && lic.token) headers['X-Repo-Token'] = lic.token;   /* 与作者令牌同头，CORS 白名单不另开列 */
    global.fetch(base() + path, {
      method: method || 'GET',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (js) { return { status: r.status, js: js }; });
    }).then(function (res) {
      var js = res.js || {};
      cb({ ok: !!js.ok, status: res.status, message: js.message || '',
        data: js, devices: js.devices || null });
    }, function (e) {
      cb({ ok: false, message: '连不上仓库服务：' + ((e && e.message) || e) });
    });
  }

  /* 登录/激活成功后刷新 lastVerifiedAt —— 7 天离线宽限的计时起点（内测期不设强闸） */
  function licSaveSession(token, qq) {
    licSet({ token: token, qq: qq, lastVerifiedAt: Date.now() });
  }

  function licActivate(code, qq, pass, cb) {
    licRequest('/account/activate', 'POST',
      { code: code, qq: qq, pass: pass, installId: deviceId(), ua: global.navigator.userAgent }, function (r) {
        if (r.ok) licSaveSession(r.data.token, r.data.qq);
        cb(r);
      });
  }

  function licLogin(qq, pass, cb) {
    licRequest('/account/login', 'POST',
      { qq: qq, pass: pass, installId: deviceId(), ua: global.navigator.userAgent }, function (r) {
        if (r.ok) licSaveSession(r.data.token, r.data.qq);
        cb(r);
      });
  }

  function licLogout(cb) {
    var lic = licGet();
    var done = function () { licSet(null); if (cb) cb({ ok: true }); };
    if (!lic || !lic.token) { done(); return; }
    /* 先请求后清本地：请求失败也照样清（本地退出不该被网络卡住） */
    licRequest('/account/logout', 'POST', null, done);
  }

  function licMe(cb) {
    licRequest('/account/me', 'GET', null, function (r) {
      if (r.ok) {
        var lic = licGet() || {};
        lic.lastVerifiedAt = r.data.now || Date.now();
        lic.qq = r.data.qq || lic.qq;
        licSet(lic);
      }
      cb(r);
    });
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
    packWorldbook: packWorldbook,
    packIsland: packIsland,
    packTheme: packTheme,
    packPreset: packPreset,
    packBook: packBook,
    importWorldbook: importWorldbook,
    themePayloadOf: themePayloadOf,
    applyThemePayload: applyThemePayload,
    themePresets: themePresets,
    saveThemePreset: saveThemePreset,
    deleteThemePreset: deleteThemePreset,
    importTheme: importTheme,
    importPreset: importPreset,
    importBook: importBook,
    applyLocks: applyLocks,
    unlockItems: unlockItems,
    lockedCount: lockedCount,
    publish: publish,
    publicShelf: publicShelf,
    itemMeta: itemMeta,
    deviceId: deviceId,
    likedIds: likedIds,
    likeItem: likeItem,
    listComments: listComments,
    postComment: postComment,
    checkCondition: checkCondition,
    myInbox: myInbox,
    verifyGate: verifyGate,
    shelf: shelf,
    downloadItem: downloadItem,
    unpublish: unpublish,
    parseGateText: parseGateText,
    importChar: importChar,
    importIsland: importIsland,
    /* 授权层（账密系统 v2） */
    license: licGet,
    licenseActivate: licActivate,
    licenseLogin: licLogin,
    licenseLogout: licLogout,
    licenseMe: licMe,
    licenseDevices: function (cb) { licRequest('/account/devices', 'GET', null, cb); },
    licenseRevoke: function (devId, cb) { licRequest('/account/devices/' + encodeURIComponent(devId) + '/revoke', 'POST', null, cb); },
    licensePassword: function (oldPass, newPass, cb) { licRequest('/account/password', 'POST', { oldPass: oldPass, newPass: newPass }, cb); },
    licenseForget: function (pass, cb) { licRequest('/account/forget', 'POST', { pass: pass }, function (r) {
      if (r.ok) licSet(null);   /* 注销成功清本机登录态 */
      cb(r);
    }); }
  };

})(window);
