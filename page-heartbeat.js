/* ============================================================
   page-heartbeat.js — 心声（施工卡模块 E，本轮不实现）
   依赖：store.js、ui.js、app.js

   ⚠️ 这一版是占位页：内容是写死的，只保证「点进来不报错」。
   真正的 E1（头像未读光点）/ E2（独立渲染层）要在模块 D 跑通之后做，
   E 的挂载点是聊天页的气泡头像（.msg-avatar）。

   历史遗留：这个文件末尾原本粘着一整段日记列表渲染的代码，跑到了
   })(window); 之外，一加载就 ReferenceError。已清理。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var h = ui.h;

  var PLACEHOLDER_HEARTBEATS = [
    { text: '今天摸到了云朵的边。', at: '刚刚' },
    { text: '耳机里循环着同一首歌，第 7 遍。', at: '12 分钟前' }
  ];

  Sleepy.register('heartbeat', {
    title: '心声',
    render: function (ctx) {
      var body = ctx.body;

      body.appendChild(h('p', 'set-group-note',
        '这里会放她没说出口的话。施工卡模块 E 做完之后才接真数据。'));

      var feed = h('div', 'heartbeat-feed');
      PLACEHOLDER_HEARTBEATS.forEach(function (item) {
        var row = h('div', 'heartbeat-item');
        row.appendChild(h('p', 'heartbeat-text', item.text));
        row.appendChild(h('p', 'heartbeat-time', item.at));
        feed.appendChild(row);
      });
      body.appendChild(feed);
    }
  });

})(window);
