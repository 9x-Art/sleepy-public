/* ============================================================
   sticker-cut.js — C2 贴纸工坊 · 固定 3×2 切片器（2026-10-02）
   ------------------------------------------------------------
   施工单 §五口径：
   · 主流程 = 固定 3×2 网格切 6 格 → 每格独立四角近白 flood-fill 去背景
     → 每格单独 alpha bbox（可配置外扩）→ 输出 PNG。
   · **禁止全局「近白→透明」**：那会把 die-cut 白边一起抠掉 ——
     只清除与格子四角背景连通的近白区域。
   · 连通域整体切割不作为主路径（留未来自适应版）。
   · 空格 / 全透明 / 面积过小 → empty 状态，绝不静默产出空贴纸。

   纯函数区（可单测，吃 {data,width,height} 形状的 imageData，不碰 DOM）：
     removeOuterBackground(imageData, options)
     splitStickerSheet3x2(imageData, options)
     trimStickerCell(cellImageData, options)
   浏览器包装区（非纯函数）：
     cutSheet3x2(blob, options) → Promise<[6 格结果]>
   依赖：无（原生 API）；index.html defer 引入。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* -------------------- 纯函数区 -------------------- */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 近白判定：三通道都 >= threshold（默认 235）。加 maxSpread 允许四角
     颜色略有差异（施工单 §九C：四角颜色略差也要能处理）。 */
  function nearWhite(r, g, b, a, threshold) {
    if (a === 0) return true;                 /* 已透明 = 背景 */
    return r >= threshold && g >= threshold && b >= threshold;
  }

  /* 四角 flood-fill：把与四角近白像素连通的背景全部置 alpha=0。
     imageData 会被就地修改（调用方传克隆或明确接受改写）。 */
  function removeOuterBackground(imageData, options) {
    var o = options || {};
    var threshold = clamp(o.threshold == null ? 235 : o.threshold, 128, 255);
    var w = imageData.width, h = imageData.height;
    var d = imageData.data;
    var visited = new Uint8Array(w * h);
    var stack = [];

    function pushIfBg(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      var idx = y * w + x;
      if (visited[idx]) return;
      var p = idx * 4;
      if (!nearWhite(d[p], d[p + 1], d[p + 2], d[p + 3], threshold)) return;
      visited[idx] = 1;
      stack.push(idx);
    }

    /* 种子 = 四条边上的近白像素（覆盖贴纸贴到格子边缘时的缺口） */
    var i;
    for (i = 0; i < w; i++) { pushIfBg(i, 0); pushIfBg(i, h - 1); }
    for (i = 0; i < h; i++) { pushIfBg(0, i); pushIfBg(w - 1, i); }

    while (stack.length) {
      var idx = stack.pop();
      var x = idx % w, y = (idx - x) / w;
      d[idx * 4 + 3] = 0;
      pushIfBg(x - 1, y); pushIfBg(x + 1, y);
      pushIfBg(x, y - 1); pushIfBg(x, y + 1);
    }
    return imageData;
  }

  /* 每格 alpha bbox：返回 {x, y, w, h, empty}；padding 外扩并 clamp 进格子。 */
  function trimStickerCell(cellImageData, options) {
    var o = options || {};
    var padding = clamp(o.padding == null ? 4 : o.padding, 0, 64);
    var minPixels = clamp(o.minPixels == null ? 144 : o.minPixels, 1, 1e9);
    var w = cellImageData.width, h = cellImageData.height;
    var d = cellImageData.data;
    var minX = w, minY = h, maxX = -1, maxY = -1, opaque = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          opaque++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || opaque < minPixels) return { empty: true, opaque: opaque };
    minX = clamp(minX - padding, 0, w - 1);
    minY = clamp(minY - padding, 0, h - 1);
    maxX = clamp(maxX + padding, 0, w - 1);
    maxY = clamp(maxY + padding, 0, h - 1);
    return {
      empty: false, opaque: opaque,
      x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1
    };
  }

  /* 主流程：3×2 网格 → 6 格结果。返回数组元素：
     { sliceIndex, empty, bbox:{x,y,w,h}(整版坐标), imageData:{width,height,data} }
     imageData 已去背景并裁到 bbox；empty 格的 imageData 为 null。 */
  function splitStickerSheet3x2(imageData, options) {
    var o = options || {};
    var W = imageData.width, H = imageData.height;
    var cellW = Math.floor(W / 3), cellH = Math.floor(H / 2);
    if (cellW < 8 || cellH < 8) {
      throw new Error('整版太小，切不出 3×2（' + W + 'x' + H + '）');
    }
    var out = [];
    for (var row = 0; row < 2; row++) {
      for (var col = 0; col < 3; col++) {
        var sliceIndex = row * 3 + col;
        var cx = col * cellW, cy = row * cellH;
        /* 克隆格子区域（不改原图） */
        var cell = { width: cellW, height: cellH, data: new Uint8ClampedArray(cellW * cellH * 4) };
        for (var y = 0; y < cellH; y++) {
          var src = ((cy + y) * W + cx) * 4;
          cell.data.set(imageData.data.subarray(src, src + cellW * 4), y * cellW * 4);
        }
        removeOuterBackground(cell, o);
        var t = trimStickerCell(cell, o);
        if (t.empty) {
          out.push({ sliceIndex: sliceIndex, empty: true, bbox: null, imageData: null, opaque: t.opaque });
          continue;
        }
        /* 裁到 bbox（逐行拷贝，源行起点随 yy 平移） */
        var cw = t.w, ch = t.h;
        var cut = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) };
        for (var yy = 0; yy < ch; yy++) {
          var s2 = ((t.y + yy) * cellW + t.x) * 4;
          cut.data.set(cell.data.subarray(s2, s2 + cw * 4), yy * cw * 4);
        }
        out.push({
          sliceIndex: sliceIndex, empty: false,
          bbox: { x: cx + t.x, y: cy + t.y, w: cw, h: ch },
          imageData: cut, opaque: t.opaque
        });
      }
    }
    return out;
  }

  /* -------------------- 浏览器包装区（非纯函数） -------------------- */

  function blobToImageData(blob) {
    return createImageBitmap(blob).then(function (bmp) {
      var cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      var cx = cv.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      var data = cx.getImageData(0, 0, bmp.width, bmp.height);
      if (bmp.close) bmp.close();
      return data;
    });
  }

  function imageDataToBlob(imageData) {
    var cv = document.createElement('canvas');
    cv.width = imageData.width; cv.height = imageData.height;
    /* splitStickerSheet3x2 返回的是裸 {data,width,height}（纯函数区不碰 DOM），
       putImageData 只认真 ImageData 实例 —— 这里重建一份 */
    var real = new ImageData(new Uint8ClampedArray(imageData.data),
      imageData.width, imageData.height);
    cv.getContext('2d').putImageData(real, 0, 0);
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (b) {
        if (b) resolve(b);
        else reject(new Error('切片导出 PNG 失败'));
      }, 'image/png');
    });
  }

  /* 工坊主入口：整版 blob → 6 格 {sliceIndex, blob, width, height, empty, bbox}。
     重切 = 换 options.threshold 重新调用（不碰任何已入库数据）。 */
  function cutSheet3x2(blob, options) {
    return blobToImageData(blob).then(function (imgData) {
      var cells = splitStickerSheet3x2(imgData, options);
      return Promise.all(cells.map(function (c) {
        if (c.empty) {
          return { sliceIndex: c.sliceIndex, empty: true, blob: null, width: 0, height: 0, bbox: null };
        }
        return imageDataToBlob(c.imageData).then(function (b) {
          return {
            sliceIndex: c.sliceIndex, empty: false,
            blob: b, width: c.imageData.width, height: c.imageData.height,
            bbox: c.bbox
          };
        });
      }));
    });
  }

  Sleepy.stickerCut = {
    removeOuterBackground: removeOuterBackground,
    splitStickerSheet3x2: splitStickerSheet3x2,
    trimStickerCell: trimStickerCell,
    cutSheet3x2: cutSheet3x2,
    blobToImageData: blobToImageData
  };

})(window);
