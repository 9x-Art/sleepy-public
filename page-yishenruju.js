/* ============================================================
   page-yishenruju.js — 「以身入局」App（首版：诚实占位页）

   《以身入局》是什么：宝宝还没定好玩法，这版只是把桌面格点亮 +
   一个诚实的「这一页还没贴好」占位页（镜像「工坊 / 查手机」早期那套）。
   等宝宝想好「入局」到底怎么玩（玩法 / 入口 / 数据），再在这里填真实功能。

   红线：不冒充完成。点开看到的是占位提示，不是假功能；
   所以这里只有一个 render，没有任何假装能用的按钮。
   依赖：app.js（Sleepy.register / ctx）、ui.js（Sleepy.ui.h）、core.js。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var h = ui.h;

  Sleepy.register('yishenruju', {
    title: '以身入局',
    /* 占位页：只读展示一句提示。没有 onShow / 没有动态数据，
       每次打开都是这一句，符合「还没布置好」的状态。 */
    render: function (ctx) {
      ctx.setTitle('以身入局');
      ctx.setActions([]);
      ctx.body.innerHTML = '';
      ctx.body.appendChild(h('p', 'ph-entry-lead',
        '「以身入局」还没布置好 —— 宝宝想好要怎么玩，这页就活过来啦。'));
    }
  });
})(window);
