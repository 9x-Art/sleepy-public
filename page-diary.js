/* ============================================================
   page-diary.js — 手账本（软装阶段功能，本轮只保证能正常渲染）
   依赖：store.js、ui.js、app.js

   数据：store 的 diaries: [{ id, content, timestamp, status }]
     status: 'written' 已写 / 'pending' 待补

   ⚠️ 上一版这里引用了 store / h / relativeTime 三个当前作用域里不存在的
   标识符（只声明了 Sleepy），一点「手账本」就抛错。现已补上别名。

   待办（等做模块 D 的加号面板「日记」入口时一起处理）：
     - 「定时写」不能靠内存里的 setTimeout（刷新就丢），要存目标时间戳，
       下次打开发起补算
     - 目前只读不写，写入口在聊天页的加号面板里
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var relativeTime = ui.relativeTime;

  function getDiaries() {
    var list = store.get('diaries');
    return Array.isArray(list) ? list : [];
  }

  Sleepy.register('diary', {
    title: '手账本',
    render: function (ctx) {
      var body = ctx.body;

      var feed = h('div', 'diary-feed');
      var emptyWrap = h('div', 'empty');
      emptyWrap.appendChild(h('div', 'empty-paper'));
      emptyWrap.appendChild(h('p', 'empty-text', '这一页还是空的'));
      emptyWrap.appendChild(h('p', 'empty-hint', '写日记的入口在字条的加号面板里'));

      body.appendChild(emptyWrap);
      body.appendChild(feed);

      function rebuild() {
        var list = getDiaries().slice().sort(function (a, b) {
          return (b.timestamp || 0) - (a.timestamp || 0);
        });

        feed.innerHTML = '';
        emptyWrap.style.display = list.length ? 'none' : 'flex';

        list.forEach(function (d) {
          var written = d.status === 'written';
          var item = h('div', 'diary-item');

          item.appendChild(h('span', 'diary-time',
            written ? relativeTime(d.timestamp) : '待写'));

          var content = h('div', 'diary-content');
          var text = h('p', 'diary-text', d.content || '');
          if (!written) text.classList.add('is-pending');
          content.appendChild(text);

          if (!written) {
            var remind = h('button', 'diary-remind', '现在写');
            remind.type = 'button';
            remind.addEventListener('click', function () {
              var next = prompt('补写这篇：', d.content || '');
              if (next === null) return;
              next = String(next).trim();
              if (!next) return;
              var all = getDiaries();
              all.forEach(function (x) {
                if (x.id !== d.id) return;
                x.content = next;
                x.status = 'written';
                x.timestamp = Date.now();
              });
              store.set('diaries', all);
              rebuild();
              ctx.toast('补好了', 'ok');
            });
            content.appendChild(remind);
          }

          item.appendChild(content);
          feed.appendChild(item);
        });
      }

      ctx.rebuild = rebuild;
      rebuild();
    },
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

})(window);
