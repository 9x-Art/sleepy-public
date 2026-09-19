/* ============================================================
   media.js — 图片 / 文件的二进制仓库（IndexedDB）

   为什么要有这一层：
     localStorage 只有 5MB，而且存的是**字符串**。一张手机照片 base64 之后
     轻松 3–8MB，存两张就爆配额；爆了之后 setItem 直接抛 QuotaExceededError，
     连带把后面所有 key 都写不进去 —— 那是「整个 App 的数据层一起坏掉」，
     不是「这张图没存上」。

     所以二进制一律走 IndexedDB（配额是磁盘的百分之几十，通常几百 MB 起），
     localStorage 里只留一个 `mediaId` 当引用。photos.js / 聊天附件 / 表情包
     都从这里取 blob。

   两条路径都要活着：
     - IDB 可用（正常浏览器）→ blob 存这儿，读取用 URL.createObjectURL
     - IDB 不可用（无痕模式、老浏览器、file:// 下的个别情况）
       → `available()` 返回 false，调用方回退到老的 dataURL 路径，
         功能降级但不崩。

   ---- 用到的三个概念，别混 ----
     put(blob, meta)  存进去，拿到 id
     get(id)          取记录 { id, blob, size, type, name, kind, at, w, h }
     url(id)          objectURL（**带缓存**，同一个 id 反复调用只建一次；
                      这些 URL 活到页面关闭，量级很小，不做 revoke 管理）
   ============================================================ */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  var DB_NAME = 'sleepy-media';
  var DB_VER = 1;
  var STORE = 'files';

  /* 长边缩到 1600：比 photos.js 的 1280 松一点 ——
     那是为了塞进 localStorage 才压得那么狠，走 IDB 就没必要了。
     但还是要压：手机原图 4000px 宽，一张 8MB，相册翻起来也卡。 */
  var MAX_EDGE = 1600;
  var QUALITY = 0.82;

  var supported = !!global.indexedDB;
  var dbPromise = null;
  var urlCache = {};

  /* ---------------------------- 打开 ---------------------------- */

  function open() {
    if (!supported) return Promise.reject(new Error('这台设备不支持 IndexedDB'));
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VER);
      } catch (e) { reject(e); return; }

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('at', 'at');
          os.createIndex('kind', 'kind');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打不开图库')); };
      /* 另一个标签页开着旧版本时会卡住 —— 与其转圈，不如报错让调用方降级 */
      req.onblocked = function () { reject(new Error('图库被另一个标签页占着，关掉它再试')); };
    });

    /* 失败后把 promise 清掉，下次还能重试（比如用户关掉了那个标签页） */
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  /* 探活：能不能用。调用方拿它决定「走 IDB 还是回退 dataURL」。
     真去开一次库，不只是看 API 在不在 —— 无痕模式下 API 在但开库会失败。 */
  function available() {
    if (!supported) return Promise.resolve(false);
    return open().then(function () { return true; }, function () { return false; });
  }

  function withStore(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t;
        try { t = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
        var os = t.objectStore(STORE);
        var out;
        try { out = fn(os); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error || new Error('图库读写失败')); };
        t.onabort = function () { reject(t.error || new Error('图库写入被中断')); };
      });
    });
  }

  function newId() {
    return 'md' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------------------- 写 ---------------------------- */

  /* put(blob, meta) → Promise<id>
     meta: { id?, name?, kind?, w?, h?, at? } —— 都可不传 */
  function put(blob, meta) {
    meta = meta || {};
    if (!blob) return Promise.reject(new Error('没有内容'));

    var rec = {
      id: meta.id || newId(),
      blob: blob,
      at: meta.at || Date.now(),
      size: blob.size || 0,
      type: blob.type || '',
      name: meta.name || '',
      kind: meta.kind || 'image',
      w: meta.w || 0,
      h: meta.h || 0
    };

    return withStore('readwrite', function (os) { os.put(rec); }).then(function () {
      return rec.id;
    });
  }

  function get(id) {
    if (!id) return Promise.resolve(null);
    var out = null;
    return withStore('readonly', function (os) {
      var req = os.get(id);
      req.onsuccess = function () { out = req.result || null; };
    }).then(function () { return out; });
  }

  function remove(id) {
    if (!id) return Promise.resolve(false);
    if (urlCache[id]) {
      try { global.URL.revokeObjectURL(urlCache[id]); } catch (e) { /* 忽略 */ }
      delete urlCache[id];
    }
    return withStore('readwrite', function (os) { os.delete(id); }).then(function () {
      return true;
    });
  }

  /* 拿到可以塞进 <img src> / CSS url() 的地址。
     缓存在这里：同一张图在相册、照片墙、聊天里可能同时显示，
     每处各建一个 objectURL 就是白占内存。 */
  function url(id) {
    if (!id) return Promise.resolve('');
    if (urlCache[id]) return Promise.resolve(urlCache[id]);
    return get(id).then(function (rec) {
      if (!rec || !rec.blob) return '';
      var u = global.URL.createObjectURL(rec.blob);
      urlCache[id] = u;
      return u;
    }, function () { return ''; });
  }

  /* dataURL(id) → Promise<dataURL 字符串>
     给「要把图发给模型看」的地方用（聊天多模态 / 朋友圈读图）——
     objectURL 只在本机浏览器里有意义，接口认的是 data: 或 http:。
     缓存的是 Promise 本身：并发来两份请求也只读一次文件。 */
  var dataCache = {};
  function dataURL(id) {
    if (!id) return Promise.resolve('');
    if (dataCache[id]) return dataCache[id];
    dataCache[id] = get(id).then(function (rec) {
      if (!rec || !rec.blob) { delete dataCache[id]; return ''; }
      return new Promise(function (res) {
        try {
          var fr = new FileReader();
          fr.onload = function () { res(String(fr.result || '')); };
          fr.onerror = function () { res(''); };
          fr.readAsDataURL(rec.blob);
        } catch (e) { res(''); }
      });
    }, function () { delete dataCache[id]; return ''; });
    return dataCache[id];
  }

  /* ---------------------------- 统计 ---------------------------- */

  /* usage() → Promise<{ bytes, count, byKind }>
     遍历全表累加。几百条记录量级下很快（IDB 游标是原生的）。
     用于设置页的「存储空间」显示。 */
  function usage() {
    var bytes = 0, count = 0, byKind = {};
    return withStore('readonly', function (os) {
      var req = os.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        var v = cur.value || {};
        bytes += v.size || 0;
        count++;
        var k = v.kind || 'other';
        byKind[k] = (byKind[k] || 0) + (v.size || 0);
        cur.continue();
      };
    }).then(function () {
      return { bytes: bytes, count: count, byKind: byKind };
    }, function () {
      return { bytes: 0, count: 0, byKind: {} };
    });
  }

  /* 清空。**破坏性** —— 调用方必须先确认（设置页那里有二次确认）。 */
  function clear() {
    Object.keys(urlCache).forEach(function (k) {
      try { global.URL.revokeObjectURL(urlCache[k]); } catch (e) { /* 忽略 */ }
    });
    urlCache = {};
    return withStore('readwrite', function (os) { os.clear(); }).then(function () {
      return true;
    });
  }

  /* ---------------------------- 压缩 ---------------------------- */

  /* shrink(file, maxEdge?) → Promise<{ blob, w, h }>
     图片走 canvas 压到长边 maxEdge 以内（本来就小的不放大）；
     非图片原样返回 —— 聊天里的「文件」附件也是这样进来的。

     和 photos.js 里那个 readImageScaled 的区别：那边出的是 dataURL（要给
     localStorage 用），这里出的是 Blob（要给 IDB 用）。 */
  function shrink(file, maxEdge) {
    maxEdge = maxEdge || MAX_EDGE;
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没有文件')); return; }
      if (!/^image\//.test(file.type || '')) {
        resolve({ blob: file, w: 0, h: 0 });
        return;
      }

      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('读不出来这个文件')); };
      fr.onload = function () { toCanvas(fr.result); };
      fr.readAsDataURL(file);

      function toCanvas(raw) {
        var img = new Image();
        img.onerror = function () { reject(new Error('这个图片格式打不开')); };
        img.onload = function () {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) { reject(new Error('图片尺寸读不出来')); return; }

          var scale = Math.min(1, maxEdge / Math.max(w, h));
          var tw = Math.max(1, Math.round(w * scale));
          var th = Math.max(1, Math.round(h * scale));

          var cv = document.createElement('canvas');
          cv.width = tw; cv.height = th;
          var cx = cv.getContext('2d');
          if (!cx) { reject(new Error('这台设备画不了 canvas')); return; }

          /* 透明底（PNG）转 JPEG 会变黑，先铺白 */
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, tw, th);
          cx.drawImage(img, 0, 0, tw, th);

          cv.toBlob(function (b) {
            if (!b) { reject(new Error('压缩失败')); return; }
            resolve({ blob: b, w: tw, h: th });
          }, 'image/jpeg', QUALITY);
        };
        img.src = raw;
      }
    });
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.media = {
    available: available,
    put: put,
    get: get,
    remove: remove,
    url: url,
    dataURL: dataURL,
    usage: usage,
    clear: clear,
    shrink: shrink,
    MAX_EDGE: MAX_EDGE,
    /* 给人看的容量文案。设置页和相册都要用，放这儿一份，别各写各的 */
    fmtBytes: function (n) {
      n = n || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
  };

})(window);
