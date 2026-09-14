/* page-moments.js — 朋友圈页（MVP） */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  Sleepy.register('moments', {
    title: '朋友圈',
    render: function (ctx) {
      var body = ctx.body;
      body.innerHTML = 
        '<h2 class="page-title">朋友圈</h2>' +
        '<div class="moments-feed"></div>';
      
      var feed = body.querySelector('.moments-feed');
      feed.innerHTML = 
        '<div class="moment-item">' +
          '<div class="moment-header">' +
            '<img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%237A5C4A\'%3E%3Cpath d=\'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z\'/%3E%3C/svg%3E" alt="头像" class="moment-avatar">' +
            '<span class="moment-name">她</span>' +
          '</div>' +
          '<p class="moment-text">晒了张窗台上的绿萝，新长出两片小叶子。</p>' +
          '<p class="moment-time">2小时前</p>' +
        '</div>' +
        '<div class="moment-item">' +
          '<div class="moment-header">' +
            '<img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%237A5C4A\'%3E%3Cpath d=\'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z\'/%3E%3C/svg%3E" alt="头像" class="moment-avatar">' +
            '<span class="moment-name">她</span>' +
          '</div>' +
          '<p class="moment-text">听到了雨滴在玻璃上走迷宫的声音。</p>' +
          '<p class="moment-time">昨天</p>' +
        '</div>';
    }
  });
})(window);