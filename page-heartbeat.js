/* page-heartbeat.js — 心声页（MVP） */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  Sleepy.register('heartbeat', {
    title: '心声',
    render: function (ctx) {
      var body = ctx.body;
      body.innerHTML = 
        '<h2 class="page-title">心声</h2>' +
        '<div class="heartbeat-feed"></div>';
      
      var feed = body.querySelector('.heartbeat-feed');
      feed.innerHTML = 
        '<div class="heartbeat-item">' +
          '<p class="heartbeat-text">今天摸到了云朵的边。</p>' +
          '<p class="heartbeat-time">刚刚</p>' +
        '</div>' +
        '<div class="heartbeat-item">' +
          '<p class="heartbeat-text">耳机里循环着同一首歌，第7遍。</p>' +
          '<p class="heartbeat-time">12分钟前</p>' +
        '</div>';
    }
  });
})(window);
      /* ======================= 日记列表渲染 ======================= */
      var diaries = store.get('diaries') || [];
      diaries.sort(function (a, b) { return b.timestamp - a.timestamp; });
      
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
              render();
              ctx.toast('日记已补写', 'ok');
            }
          });
          contentEl.appendChild(remindBtn);
        }
        
        diaryItem.appendChild(timeEl);
        diaryItem.appendChild(contentEl);
        heartbeatFeed.appendChild(diaryItem);
      });