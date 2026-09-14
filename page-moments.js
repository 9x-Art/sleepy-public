/* ============================================================
   page-moments.js — 拼贴墙（朋友圈，软装阶段功能）
   依赖：store.js、ui.js、app.js

   ⚠️ 内容还是写死的示例，只保证「点进来不报错、样式统一」。
   真数据要等「分享卡 / char 发朋友圈」那一批需求定清楚再做。

   历史遗留：上一版用 body.innerHTML 拼字符串，并在里面塞了一个
   <h2 class="page-title"> 当标题——那个类根本没有 CSS，而且在
   app-head 之外又出了第二个标题。现已改成走 ctx.setTitle。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var h = ui.h;

  var AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%237A5C4A'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z'/%3E%3C/svg%3E";

  var PLACEHOLDER = [
    { text: '晒了张窗台上的绿萝，新长出两片小叶子。', at: '2 小时前' },
    { text: '听到了雨滴在玻璃上走迷宫的声音。', at: '昨天' }
  ];

  Sleepy.register('moments', {
    title: '朋友圈',
    render: function (ctx) {
      var body = ctx.body;

      body.appendChild(h('p', 'set-group-note',
        '角色愿意给你看的东西，会贴在这面墙上。现在是示例内容。'));

      var feed = h('div', 'moment-feed');
      PLACEHOLDER.forEach(function (m) {
        var item = h('div', 'moment-item');

        var head = h('div', 'moment-head');
        var av = h('img', 'moment-avatar');
        av.src = AVATAR;
        av.alt = '角色';
        head.appendChild(av);
        head.appendChild(h('span', 'moment-name', '角色'));
        item.appendChild(head);

        item.appendChild(h('p', 'moment-text', m.text));
        item.appendChild(h('p', 'moment-time', m.at));
        feed.appendChild(item);
      });
      body.appendChild(feed);
    }
  });

})(window);
