/* page-diary.js — 日记页 */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  Sleepy.register('diary', {
    title: '日记',
    render: function (ctx) {
      var body = ctx.body;
      var diaries = store.get('diaries') || [];
      diaries.sort(function (a, b) { return b.timestamp - a.timestamp; });
      
      var diaryFeed = h('div', 'diary-feed');
      if (diaries.length === 0) {
        diaryFeed.innerHTML = '<p class="empty-text">还没有写过任何日记</p>' +
          '<p class="empty-hint">点击下方 + 新建一篇日记</p>';
      } else {
        diaries.forEach(function (d) {
          var diaryItem = h('div', 'diary-item');
          
          // 左侧时间戳
          var timeEl = h('span', 'diary-time');
          timeEl.textContent = d.status === 'written' ? relativeTime(d.timestamp) : '待写';
          
          // 右侧内容
          var contentEl = h('div', 'diary-content');
          if (d.status === 'written') {
            contentEl.innerHTML = '<p>' + d.content.replace(/\n/g, '<br>') + '</p>';
          } else {
            contentEl.textContent = '记得写今天的日记哦：' + d.content.slice(0, 20) + '…';
            contentEl.style.color = '#888';
          }
          
          // 状态标记
          if (d.status === 'pending') {
            var remindBtn = h('button', 'diary-remind');
            remindBtn.textContent = '现在写';
            remindBtn.addEventListener('click', function () {
              var newContent = prompt('补写日记：', d.content);
              if (newContent !== null && newContent.trim()) {
                d.content = newContent.trim();
                d.status = 'written';
                d.timestamp = Date.now();
                store.set('diaries', diaries);
                ctx.open('diary');
              }
            });
            contentEl.appendChild(remindBtn);
          }
          
          diaryItem.appendChild(timeEl);
          diaryItem.appendChild(contentEl);
          diaryFeed.appendChild(diaryItem);
        });
      }
      body.appendChild(diaryFeed);
    }
  });
})(window);