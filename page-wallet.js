/* ============================================================
   page-wallet.js — 钱包（聊天 App ·「我」里的一个入口）

   流水**不单独存一张表**：转账本来就是对话里的一条消息
   （`type:'transfer'`，见 page-chat.js 的 parseTransfer / transferCard）。
   扫一遍消息就能拿到流水，而且白捡三件事：

     · 「这笔落到哪段对话」直接查得到 —— 点一下就跳过去，不用另建关联
     · 不会出现「钱包里有记录、对话里却没有」这种两边对不上的情况
     · 天然按沙盒隔离（消息本来就按房存）

   唯一需要单独存的是**余额**：它不是流水能推出来的东西
   （转账只记支出，没有入账口），所以给用户一个自己填的地方 ——
   模拟「充了多少零钱」。

   数据：wallet: [{ id, balance, sandboxId }]（一间房一条）

   依赖：store.js、core.js、ui.js、app.js
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var ui = Sleepy.ui;
  var store = Sleepy.store;
  var core = Sleepy.core;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var button = ui.button;

  function money(n) {
    return '¥' + (Number(n) || 0).toFixed(2);
  }

  function timeText(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 当前这间房的余额。没有就当作 0（不写盘 —— 用户不动它就别产生数据）。 */
  function balance() {
    var list = core.scoped(store.get('wallet'));
    var rec = list[0];
    return rec ? Number(rec.balance) || 0 : 0;
  }

  /* 写余额。⚠️ 必须拿**全量**列表按房找那一条再落盘 ——
     用 core.scoped() 过滤过的列表回写会把别的房的记录抹掉。 */
  function setBalance(v) {
    var all = store.get('wallet');
    if (!Array.isArray(all)) all = [];
    var sid = core.scopeId();
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].sandboxId === sid) { all[i].balance = v; store.set('wallet', all); return; }
    }
    all.push(core.tagScope({ id: core.newId('wl'), balance: v }));
    store.set('wallet', all);
  }

  /* 扫出当前这间房的转账。按时间倒序 —— 账单就该最近的在最上面。 */
  function entries() {
    var cs = Sleepy.chatStore;
    if (!cs) return [];
    var out = [];
    cs.getChats().forEach(function (c) {
      (c.messages || []).forEach(function (m) {
        if (!m || m.type !== 'transfer') return;
        out.push({
          chatId: c.id,
          chatName: c.name || '对话',
          messageId: m.id,
          amount: Number(m.amount) || 0,
          note: m.note || '',
          at: m.timestamp || 0
        });
      });
    });
    out.sort(function (a, b) { return b.at - a.at; });
    return out;
  }

  Sleepy.register('wallet', {
    title: '钱包',
    render: function (ctx) {
      var body = ctx.body;

      /* ---- 余额 ---- */
      var hero = h('div', 'wallet-hero');
      var amt = h('div', 'wallet-amt', money(balance()));
      var lab = h('div', 'wallet-lab', '零钱');
      hero.appendChild(lab);
      hero.appendChild(amt);
      var edit = h('button', 'wallet-edit', '改一下');
      edit.type = 'button';
      edit.addEventListener('click', function () {
        ui.prompt({
          title: '零钱有多少',
          note: '转账只记支出，所以余额得你自己给个数（就当充了点零钱）。',
          value: String(balance()),
          ok: '记下来'
        }).then(function (v) {
          if (v === null) return;
          var n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
          if (!isFinite(n) || n < 0) { ctx.toast('得是个不小于 0 的数', 'err'); return; }
          setBalance(Math.round(n * 100) / 100);
          amt.textContent = money(balance());
          ctx.toast('记下来了', 'ok');
        });
      });
      hero.appendChild(edit);
      body.appendChild(hero);

      /* ---- 流水 ---- */
      var list = entries();
      var total = list.reduce(function (a, e) { return a + e.amount; }, 0);

      var g = group('转账记录',
        list.length
          ? ('这间房里一共转出去 ' + money(total) + ' · ' + list.length + ' 笔')
          : '这间房里还没有转过账');

      if (!list.length) {
        g.card.appendChild(row({
          label: '还没有流水',
          hint: '在对话里点 + → 转账，这里就会记上一笔'
        }));
      }

      list.forEach(function (e) {
        g.card.appendChild(row({
          label: '转给「' + e.chatName + '」  ' + money(e.amount),
          hint: (e.note ? e.note + ' · ' : '') + timeText(e.at) + ' · 点一下回到那段对话',
          /* 点一条流水 → 跳到产生它的那段对话。
             这就是「每笔转账落到哪段对话可回查」那条验收标准的落点。 */
          onClick: function () { ctx.open('chat-detail', { chatId: e.chatId }); }
        }));
      });
      body.appendChild(g.wrap);

      body.appendChild(h('p', 'set-foot',
        '流水是从对话里扫出来的，不另存一张表 —— ' +
        '所以你删掉那条消息或者拆掉那间房，对应的流水会跟着没。'));
    }
  });

  /* 对外：给「我」那一屏显示用（余额概览 / 笔数）。
     也方便冒烟直接断言，不用去读 DOM。 */
  Sleepy.wallet = {
    balance: balance,
    setBalance: setBalance,
    entries: entries
  };

})(window);
