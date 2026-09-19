/* ============================================================
   photos.js — 照片的数据层（模块 J 的底层）

   负一屏的照片墙和相册 App 是**同一份数据**的两个视图：
   照片墙是「角色愿意给你看的那几张」，相册是「全部」。
   所以这一层单独抽出来，两边都调它，避免各存各的。

   ---- 为什么不是简单地把图塞进 localStorage ----
   localStorage 只有 5MB，而且是**字符串**存储 ——
   一张手机拍的图 base64 之后轻松 3–8MB，存两张就爆配额，
   爆了之后 `setItem` 直接抛 QuotaExceededError，
   连带把别的 key 也写不进去（整个 App 的数据层一起坏掉）。

   所以这里分两层：
     1. 读进来立刻**缩放**（典型 80–200KB，人眼几乎看不出差别）
     2. 做完上一步再算一下总占用，超过 SOFT_LIMIT 就提示用户
        并在存之前拦一道，而不是等 localStorage 抛异常

   ---- 现在有了 IndexedDB（media.js）----
   图片本体改存 IDB（配额是磁盘级的，几百 MB 起），这里只留一个 `mediaId`。
   老记录里的 `url`（dataURL）继续能读 —— **升级不能让人看不见旧照片**。
   判断走哪条路看每条记录自己带的是 `mediaId` 还是 `url`，
   所以新老照片可以混在一份列表里。

   IDB 不可用（无痕模式等）时自动退回 dataURL 那条老路（media.available()）。 */

(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;

  var MAX_EDGE = 1280;       /* 缩放后的最长边 */
  var QUALITY = 0.82;        /* JPEG 质量 */
  var SOFT_LIMIT = 3.6e6;    /* 全部照片合计的软上限（字符数），留出余量给别的数据 */

  /* ---------------------------- 读写 ---------------------------- */

  /* ---- 两个口子，不要混用（同 page-chat 的 allChats/getChats）----

     allFull()  全量。**只有写入方用** —— 拿它改完再整表落盘。
                写入方误用 all() 的话，set 回去的是一份被沙盒过滤过的列表，
                别的存档的照片会被整批抹掉。
     all()      当前沙盒可见的。**读取方用**。scopeId() 为 null 时返回全部。 */
  function allFull() {
    var list = store.get('photos');
    return Array.isArray(list) ? list : [];
  }

  function all() {
    var c = Sleepy.core;
    return (c && c.scoped) ? c.scoped(allFull()) : allFull();
  }

  function save(list) { return store.set('photos', list); }

  function sizeOf(list) {
    var n = 0;
    (list || []).forEach(function (p) { n += (p && p.url ? p.url.length : 0); });
    return n;
  }

  /* 全部照片的实际占用。
     **故意用全量**：localStorage 是 5MB 一个池子，所有存档共用 ——
     只算当前房的占用会让用户以为「还很空」，然后在另一间房里撞配额。
     注意：走了 IDB 之后这里只统计**老 dataURL 记录**的占用，
     新的 blob 在 IDB 里，用 diskUsage() 看总账。 */
  function usedBytes() { return sizeOf(allFull()); }

  /* 真正的「图库占了多少」：IDB 里的 blob + 还留在 localStorage 的老 dataURL。 */
  function diskUsage() {
    var legacy = usedBytes();
    var m = Sleepy.media;
    if (!m) return Promise.resolve({ bytes: legacy, count: allFull().length, legacy: legacy, idb: false });
    return m.available().then(function (yes) {
      if (!yes) return { bytes: legacy, count: allFull().length, legacy: legacy, idb: false };
      return m.usage().then(function (u) {
        return {
          bytes: u.bytes + legacy, count: allFull().length,
          legacy: legacy, idbBytes: u.bytes, idb: true
        };
      });
    });
  }

  /* 一张照片的显示地址：新的从 IDB 现取（objectURL），老的直接给 dataURL。
     返回 Promise —— 调用方拿到后再塞进 src。 */
  function srcOf(p) {
    if (!p) return Promise.resolve('');
    if (p.mediaId) {
      var m = Sleepy.media;
      if (m) return m.url(p.mediaId).then(function (u) { return u || p.url || ''; });
    }
    return Promise.resolve(p.url || '');
  }

  function add(items) {
    var list = allFull();            /* 写入方：全量 */
    (items || []).forEach(function (it) {
      /* 有一条就算数：老记录带 url，新记录带 mediaId */
      if (!it || (!it.url && !it.mediaId)) return;
      var rec = {
        id: core.newId('ph'),
        caption: it.caption || '',
        at: it.at || Date.now()
      };
      if (it.mediaId) {
        rec.mediaId = it.mediaId;
        rec.w = it.w || 0;
        rec.h = it.h || 0;
        rec.type = it.type || '';
        rec.size = it.size || 0;
        rec.name = it.name || '';
      } else {
        rec.url = it.url;
      }
      /* 盖章。漏盖 = 这张照片在任何房里都看不见（静默丢数据） */
      if (core && core.tagScope) core.tagScope(rec);
      list.push(rec);
    });
    save(list);
    return list;
  }

  /* 删一条记录，**顺手把 IDB 里的本体也删掉** ——
     只删记录的话 blob 会留在库里变成永远拿不回来的垃圾（占配额、看不见）。 */
  function remove(id) {
    var list = allFull();
    var hit = null;
    var keep = list.filter(function (p) {
      if (p.id === id) { hit = p; return false; }
      return true;
    });
    save(keep);
    if (hit && hit.mediaId && Sleepy.media) {
      Sleepy.media.remove(hit.mediaId).catch(function () { /* 删不掉就算了，不影响记录已删 */ });
    }
  }

  function update(id, patch) {
    var list = allFull();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined) {
          list[i][k] = patch[k];
        }
      }
    }
    save(list);
  }

  /* ---------------------------- 读图 ---------------------------- */

  /* 把 File 读成**缩放后**的 dataURL。
     走 canvas 而不是 FileReader.readAsDataURL 直接拿 ——
     后者给的是原图，一张就能把 localStorage 撑爆。

     返回 Promise<string>。失败时 reject，调用方负责 toast。 */
  function readImageScaled(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没有文件')); return; }
      if (!/^image\//.test(file.type || '')) {
        reject(new Error('这不是图片'));
        return;
      }

      var raw = null;
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('读不出来这个文件')); };
      fr.onload = function () { raw = fr.result; toCanvas(); };
      fr.readAsDataURL(file);

      function toCanvas() {
        var img = new Image();
        img.onerror = function () { reject(new Error('这个图片格式打不开')); };
        img.onload = function () {
          try {
            resolve(downscale(img));
          } catch (e) {
            reject(e);
          }
        };
        img.src = raw;
      }

      /* 等比缩到 MAX_EDGE 以内。本来就小的话不放大，原样返回 ——
         放大只会更糊，还更占地方。 */
      function downscale(img) {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('图片尺寸读不出来');

        var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
        var tw = Math.max(1, Math.round(w * scale));
        var th = Math.max(1, Math.round(h * scale));

        var cv = document.createElement('canvas');
        cv.width = tw;
        cv.height = th;
        var cx = cv.getContext('2d');
        if (!cx) throw new Error('这台设备画不了 canvas');

        /* 透明背景的 PNG 转 JPEG 会变黑，先铺一层白底 */
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, tw, th);
        cx.drawImage(img, 0, 0, tw, th);

        return cv.toDataURL('image/jpeg', QUALITY);
      }
    });
  }

  /* ---------------------------- 选图 ---------------------------- */

  /* 呼出一个隐藏的 file input 让用户选图，选完读好并落盘。
     返回 Promise<新加的照片数组>（取消或全失败则是空数组）。

     opts: { multiple:boolean, title:string }
     用 file input 而不是拖拽：`file://` 下拖拽的 DataTransfer 在很多
     浏览器里拿不到真实路径，而且手机上根本没有拖拽。 */
  function pick(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = opts.multiple !== false;

      /* 用户取消时 change 不会触发 —— 会有个悬着的 Promise。
         这是无头浏览器也测不到的边界，但它只泄漏一个闭包，
         不影响功能，先接受。 */
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) { resolve([]); return; }

        var m = Sleepy.media;
        var probe = (m && m.available) ? m.available() : Promise.resolve(false);

        probe.then(function (useIdb) {
          var ok = [];          /* 新记录（带 mediaId 或 url） */
          var failed = 0;

          /* 串行而不是 Promise.all：一次解码一堆大图会把手机内存顶爆，
             而且用户看到的顺序应该和选的时候一致。 */
          var chain = Promise.resolve();
          files.forEach(function (f) {
            chain = chain.then(function () {
              if (useIdb) {
                return m.shrink(f).then(function (r) {
                  return m.put(r.blob, {
                    name: f.name, kind: 'photo', w: r.w, h: r.h
                  }).then(function (id) {
                    ok.push({
                      mediaId: id, w: r.w, h: r.h,
                      type: r.blob.type, size: r.blob.size,
                      name: f.name, at: Date.now()
                    });
                  });
                }, function () { failed++; });
              }
              /* IDB 用不了 → 退回 dataURL（老路），功能降级但不崩 */
              return readImageScaled(f).then(function (url) {
                ok.push({ url: url, at: Date.now() });
              }, function () {
                failed++;
              });
            });
          });

          chain.then(function () {
            if (!ok.length) {
              if (Sleepy.toast) Sleepy.toast('这些图都没读成功', 'err');
              resolve([]);
              return;
            }

            /* 只有 dataURL 那条路才需要算 localStorage 配额 ——
               IDB 的配额是磁盘级的，等它报错就行（而且报错也不会连累别的 key）。 */
            if (!useIdb) {
              var cur = all();
              if (sizeOf(cur) + sizeOf(ok) > SOFT_LIMIT) {
                if (Sleepy.toast) {
                  Sleepy.toast('相册放不下了，先删几张再传', 'warn');
                }
                resolve([]);
                return;
              }
            }

            var list = add(ok);
            if (failed && Sleepy.toast) {
              Sleepy.toast('有 ' + failed + ' 张没读成功', 'warn');
            }
            /* 返回新加的那几条（末尾 ok.length 个） */
            resolve(list.slice(list.length - ok.length));
          });
        });
      });

      /* 必须插进文档再 click —— 游离节点的 click 在部分浏览器里不弹窗 */
      input.style.display = 'none';
      document.body.appendChild(input);
      input.click();
    });
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.photos = {
    /* all = 当前沙盒可见（读取方用）；allFull = 全量（**只有写入方用**）。
       混用的后果见文件里那段注释。 */
    all: all,
    allFull: allFull,
    usedBytes: usedBytes,
    diskUsage: diskUsage,
    srcOf: srcOf,
    add: add,
    remove: remove,
    update: update,
    pick: pick,
    readImageScaled: readImageScaled,
    sizeOf: sizeOf,
    SOFT_LIMIT: SOFT_LIMIT,
    MAX_EDGE: MAX_EDGE
  };

})(window);
