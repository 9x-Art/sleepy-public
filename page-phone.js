/* ============================================================
   page-phone.js · 查手机（第 1 批：入口 / 锁屏 / 私人桌面 / 消息 v1）

   三个 registry：
     phonecheck  —— user 桌面第 2 屏的 App（孤岛直进 / 群岛选人）
     phone-view  —— 全屏接管：锁屏 → char 的私人手机桌面 → App
     （char 邀请卡在第 2 批接入授权流，本版三条入口路径的数据结构已就位）

   本文件里**没有任何模型调用**（架构 v1 §0.1：打开即 0 API）。
   所有内容要么镜像真实数据（chatStore / groupStore），
   要么读 phone.js 的本地表；空状态自然展示，不为填页面造数据。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;
  var h = ui.h;
  var phone = Sleepy.phone;

  /* ---------------------------- 图标 ----------------------------
     和桌面同一套线稿语言：24 格、currentColor、1.6。 */
  function ic(body) {
    return '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body + '</svg>';
  }
  var APP_IC = {
    messages: ic('<path d="M4.5 6.8A2.3 2.3 0 0 1 6.8 4.5h10.4a2.3 2.3 0 0 1 2.3 2.3v7.4a2.3 2.3 0 0 1-2.3 2.3H10l-4.2 3.2a.55.55 0 0 1-.88-.44z"/><path d="M8.5 9.3h7M8.5 12.3h4.5"/>'),
    taobao:   ic('<path d="M5.2 8.6h13.6l-1 9.9a1.7 1.7 0 0 1-1.7 1.5H7.9a1.7 1.7 0 0 1-1.7-1.5z"/><path d="M9.2 8.6V6.9a2.8 2.8 0 0 1 5.6 0v1.7"/>'),
    health:   ic('<path d="M3.6 12h3.2l2-4.4 2.8 9 2.4-6 1.6 3.2h4.8"/>'),
    notes:    ic('<rect x="5" y="4" width="14.5" height="16" rx="2"/><path d="M9 4v16"/><path d="M12.5 8.5H16M12.5 12h3.5"/>'),
    browser:  ic('<circle cx="12" cy="12" r="8.4"/><path d="M14.8 9.2l-1.6 4-4 1.6 1.6-4z"/>')
  };
  /* 这台手机里有哪些官方 App —— **日历和相册都已经不在了**
     （日历 2026-09-19 改成桌面第 3 屏的独立 App；相册 2026-10-06 下线，
      它一直只是「有壳没内容」的空态，没有专属页面也没有专属数据表）。
     渲染桌面与写 appOrder 都认这一张表，所以老存档里残留的 'calendar'
     / 'gallery' 会被 on-desk 过滤掉，不用去改存档。 */
  var PHONE_APPS = ['messages', 'taobao', 'health', 'notes', 'browser'];
  var APP_LABEL = {
    messages: '消息', taobao: '淘宝', health: '健康打卡', notes: '备忘录',
    browser: '浏览器'
  };
  /* 各 App 的自然空态文案 —— 数据为空就如实说，不造数据填页面 */
  var APP_EMPTY = {
    taobao: '他最近没有留下购物的痕迹。',
    health: '最近几天没有打卡记录。',
    notes: '他还没有写过备忘。',
    browser: '没有留下搜索或浏览的记录。'
  };

  var RISK_WORDS = ['风平浪静', '他离开了有一会儿', '有些不安', '脚步声靠近', '千钧一发'];

  /* 订单状态 / 计划状态的中文（淘宝页与入口页的迷你手机都要用 ——
     必须待在**模块级**，入口页不在 boot 的闭包里。踩过：放 boot 里
     时入口页一有订单就 ReferenceError，整页只剩空白）。 */
  var ORDER_STATUS_TXT = {
    ordered: '已下单 · 待发货', shipped: '运输中', received: '已收货',
    refunded: '已退款', gifted: '已经送出去了'
  };
  var PLAN_STATUS_TXT = {
    brewing: '构思中', preparing: '准备中', scheduled: '已安排',
    done: '已兑现', paused: '暂缓了', cancelled: '取消了', changed: '改了方案'
  };

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function timeStr(t) {
    var d = t ? new Date(t) : new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function dateStr() {
    var d = new Date();
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }

  /* ============================ 入口页 ============================ */

  Sleepy.register('phonecheck', {
    title: '查手机',
    /* 入口页也要 onShow 重绘：授权状态（已向你开放）是会变的，
       不刷新的话第二次进来看到的还是上次的残影 */
    onShow: function (ctx) {
      if (ctx.__painted && ctx.rebuild) ctx.rebuild();
      else ctx.__painted = true;
    },
    render: function entryRender(ctx) {
      /* 冷启动底片按钮落档后要原地刷新 —— shell 的 ctx 没有 rebuild，
         这里自己挂一个（照 page-chat-settings 的做法） */
      ctx.rebuild = function () { entryRender(ctx); };
      var sb = core.activeSandbox();
      ctx.setTitle('查手机');
      ctx.body.innerHTML = '';

      if (!sb) {
        ctx.body.appendChild(h('p', 'empty-hint', '还没有进入任何一座岛。'));
        return;
      }
      /* 正式 char = 大号本体。皮套是「账号」不是「人」——
         手机属于人，账号只是他在这部手机上用的小号。 */
      var mains = core.charsOfSandbox(sb.id).filter(function (c) {
        return (c.kind || 'main') === 'main';
      });
      if (!mains.length) {
        ctx.body.appendChild(h('p', 'empty-hint', '这座岛上还没有角色。'));
        return;
      }

      /* 每台手机当下的真实状态 → 入口页那句小字（Demo 08 的 people 行）。
         不编「落在窗边」这种氛围词，只用数据里真有的三种情形。 */
      function stateNote(c) {
        var ph = phone.phoneOf(sb.id, c.id);
        if (ph && phone.longPermFor(ph.id, 'all')) return '已向你开放';
        if (!ph) return '手机就放在那里，屏幕朝下。';
        if (ph.lastExitedAt == null) return '屏幕还亮着';
        var away = Date.now() - (ph.lastExitedAt || 0);
        if (away < 30 * 60000) return '像是刚刚离开';
        return '手机就放在那里，屏幕朝下。';
      }

      /* 底片行（总纲 20.5 / 架构 v1 §16）：手机还没初始化时，user 显式
         选择补不补 —— 一生一次生成调用，之后全靠真实相处生长。 */
      function appendBootstrap(host, c, ph) {
        if (ph && ph.bootstrapStatus === 'completed') return;
        var bs = h('div', 'ph-boot');
        bs.appendChild(h('p', 'ph-entry-note',
          '他的手机还几乎是空的 —— 可以补一次「初始生活底片」（生成 1 次，之后全靠真实相处生长）：'));
        [
          ['light', '轻量底片（建议）'],
          ['rich', '丰富底片'],
          ['real', '只用真实互动']
        ].forEach(function (it) {
          var b = h('button', 'ph-boot-btn', it[1]);
          b.type = 'button';
          b.addEventListener('click', function () {
            if (!Sleepy.phoneAI) { ctx.toast('生成链还没加载', 'err'); return; }
            b.disabled = true;
            ctx.toast(it[0] === 'real' ? '好，他的手机从今天开始记。' : '正在为他补生活…', 'ok');
            Sleepy.phoneAI.bootstrapPhone(sb.id, c.id, it[0]).then(function (r) {
              if (r.ok) {
                ctx.toast(r.real ? '好，他的手机从今天开始记。' : '底片补好了 —— 再进去看看。', 'ok');
                ctx.rebuild();
              } else if (r.error === 'noapi') {
                /* 原因由数据层给（用户配的可能是副 API，写死「去配主 API」会误导） */
                ctx.toast((r.reason || '还没有可用的模型') + ' · 去 设置 → 主 API 配一个', 'warn');
                b.disabled = false;
              } else if (r.error === '解析失败（原文已存）') {
                /* 别只说「失败」：告诉他原文留下来了、去哪儿重试 */
                ctx.toast('TA 的底片没解析成功 —— 原文已存下，可以再试一次', 'warn');
                b.disabled = false;
              } else {
                ctx.toast('✗ ' + (r.error || '没成'), 'err');
                b.disabled = false;
              }
            })['catch'](function (e) {
              /* ⚠️ 这个 catch 不能省：上面把按钮 disabled 了，promise 一旦 reject
                 就永远卡在禁用态、一句话都不提示（审查报告六.1 第 2 条）。 */
              ctx.toast('✗ 生成链出错了：' + ((e && e.message) || '未知错误'), 'err');
              b.disabled = false;
            });
          });
          bs.appendChild(b);
        });
        host.appendChild(bs);
      }

      /* ---------- 锁屏预览（Demo 08 的 phoneScene）----------
         入口页那张小手机：壁纸用主人真实的壁纸，通知用真实的最近事件。
         这是「捡到手机」这一幕的主角，别用一句文案代替它。 */
      function miniPhone(c, phRec) {
        var wall = ((phRec && phRec.wallpaper) || 0) % phone.WALLS.length;
        var scene = h('div', 'ph-mini-scene');
        var frame = h('div', 'ph-mini');
        /* 屏里才是壁纸（Demo 的 .phone / .screen 两层）——
           壁纸铺在整台手机上会把金属边框也涂掉 */
        var screen = h('div', 'ph-mini-screen ph-wall-' + wall);
        screen.appendChild(h('div', 'ph-mini-notch'));
        screen.appendChild(h('div', 'ph-mini-time', timeStr()));
        screen.appendChild(h('div', 'ph-mini-date', dateStr()));
        var notes = h('div', 'ph-mini-notes');
        entryNotices(phRec, c).forEach(function (n) {
          var el = h('div', 'ph-mini-note');
          var head = h('div', 'ph-mini-note-h');
          head.appendChild(h('b', null, n.t));
          head.appendChild(h('span', null, n.at ? timeStr(n.at) : '现在'));
          el.appendChild(head);
          el.appendChild(h('p', null, n.b));
          notes.appendChild(el);
        });
        screen.appendChild(notes);
        screen.appendChild(h('div', 'ph-mini-hint', '向上轻扫以打开'));
        frame.appendChild(screen);
        scene.appendChild(frame);
        return scene;
      }

      /* 迷你手机里那两条通知：只用模块级拿得到的真实数据 ——
         最近一条真实私聊（不泄露内容）+ 最近一次订单状态迁移。 */
      function entryNotices(phRec, c) {
        var out = [];
        if (phRec) {
          try {
            var latest = null;
            (Sleepy.chatStore ? Sleepy.chatStore.getChats() : []).forEach(function (ct) {
              if (core.rootIdOf(ct.characterId) !== phRec.charId) return;
              var list = (ct.messages || []).filter(function (m) { return m.role !== 'system'; });
              var last = list[list.length - 1];
              if (last && (!latest || (last.timestamp || 0) > (latest.msg.timestamp || 0))) {
                latest = { chat: ct, msg: last };
              }
            });
            if (latest) {
              var who = Sleepy.chatStore.findCharacter(latest.chat.characterId);
              out.push({ t: (who && who.name) || '消息', at: latest.msg.timestamp,
                b: '发来了一条新消息' });
            }
          } catch (e) { /* 没有就少一条 */ }
          var orders = phone.listShop(phRec.id).filter(function (o) {
            return (o.history || []).length;
          }).sort(function (a, b) { return b.at - a.at; });
          if (orders[0]) {
            var o = orders[0];
            var st = (o.history || [])[(o.history || []).length - 1];
            out.push({ t: '淘宝', at: st.at,
              b: (o.title || '订单') + ' · ' + (ORDER_STATUS_TXT[o.status] || o.status) });
          }
        }
        if (!out.length) {
          out.push({ t: '系统', at: null, b: c.name + ' 的手机还什么都没记下' });
        }
        return out.slice(0, 2);
      }

      var wrap = h('div', 'ph-entry');
      var isArchi = sb.kind === core.KIND_ARCHI;

      /* ---------- 孤岛：唯一主角色 → 直接是「捡到」这一幕 ----------
         定案 §二：孤岛不出现选人步骤。整页照 Demo 08 的 found 页：
         大标题 + 一句话 + 那部手机 + 偷看一下 / 放回原处 + 一句 micro。 */
      if (!isArchi && mains.length === 1) {
        var only = mains[0];
        var ph1 = phone.phoneOf(sb.id, only.id);
        var open1 = ph1 && !!phone.longPermFor(ph1.id, 'all');
        wrap.appendChild(h('h1', 'ph-entry-h1', '捡手机文学成真了。'));
        wrap.appendChild(h('p', 'ph-entry-lead',
          open1
            ? '「' + (only.name || '角色') + '」的手机就在你手边 —— 他对你说过，想看就看。'
            : '你捡到了「' + (only.name || '角色') + '」落下的手机。屏幕还亮着，他似乎暂时没有回来。'));
        if (ph1) wrap.appendChild(miniPhone(only, ph1));
        var dec = h('div', 'ph-entry-decision');
        var peek = h('button', 'btn btn-primary', open1 ? '拿起来看看' : '偷看一下');
        peek.type = 'button';
        peek.addEventListener('click', function () {
          /* stage:'peek' → 直接做分流，不再重放一次「捡到」（这一幕就是本页） */
          ctx.open('phone-view', { charId: only.id, stage: 'peek' });
        });
        var putBack = h('button', 'btn btn-ghost', '放回原处');
        putBack.type = 'button';
        putBack.addEventListener('click', function () {
          ctx.open('phone-view', { charId: only.id, stage: 'putback' });
        });
        dec.appendChild(peek);
        dec.appendChild(putBack);
        wrap.appendChild(dec);
        wrap.appendChild(h('p', 'ph-entry-micro', '这个选择可能会成为后来发生的事。'));
        appendBootstrap(wrap, only, ph1);
        ctx.body.appendChild(wrap);
        return;
      }

      /* ---------- 群岛：谁把手机落在这里了？ ---------- */
      wrap.appendChild(h('h1', 'ph-entry-h1', '谁把手机落在这里了？'));
      wrap.appendChild(h('p', 'ph-entry-lead',
        '群岛里不止一部手机。选择以后，才会进入属于对方的私人空间。'));

      mains.forEach(function (c) {
        var ph = phone.phoneOf(sb.id, c.id);
        var row = h('button', 'ph-entry-row');
        row.type = 'button';
        var ava = h('span', 'ph-entry-ava');
        if (c.avatar || c.avatarMedia) {
          var img = h('img'); img.alt = '';
          core.setAvatarImg(img, c);
          ava.appendChild(img);
        } else {
          ava.textContent = (c.name || '?').slice(0, 1);
        }
        row.appendChild(ava);
        var main = h('span', 'ph-entry-main');
        main.appendChild(h('span', 'ph-entry-name', c.name || '角色'));
        main.appendChild(h('span', 'ph-entry-note', stateNote(c)));
        row.appendChild(main);
        row.appendChild(h('span', 'ph-entry-arrow', '›'));
        row.addEventListener('click', function () {
          ctx.open('phone-view', { charId: c.id });
        });
        wrap.appendChild(row);
      });
      wrap.appendChild(h('p', 'ph-entry-micro', '这里只出现当前群岛内的正式角色。'));
      /* 底片行排在选人列表之后（Demo 里选人页只有人，别把按钮插进人缝里） */
      mains.forEach(function (c) {
        appendBootstrap(wrap, c, phone.phoneOf(sb.id, c.id));
      });
      ctx.body.appendChild(wrap);
    }
  });

  /* ============================ 手机本体（全屏接管） ============================

     ⚠️ 页面实例是**缓存复用**的（app.js build 每个 id 只跑一次 render）。
     「放回手机 → 再捡起来」必须是全新的一次进入：新会话、新锁屏判定、
     新的宽限期结论。所以状态全部收进 boot()，render 只负责第一次，
     之后每次 onShow（重新 open）都整段重跑。真机抓过：不重跑的话，
     第二次进来直接看见上次的桌面，session 还是旧的那条。 */

  Sleepy.register('phone-view', {
    title: '',
    render: function (ctx) {
      ctx.__boot = boot;
      boot(ctx);
    },
    onShow: function (ctx) {
      if (ctx.__booted) ctx.__boot(ctx);
      else ctx.__booted = true;
    }
  });

  function boot(ctx) {
    var sb = core.activeSandbox();
    var charId = ctx.params.charId;
    var ch = core.findChar(charId);
    if (!sb || !ch) { ctx.toast('找不到手机的主人', 'err'); ctx.back(); return; }
    var ownerId = core.rootIdOf(charId) || charId;
    var ph = phone.ensurePhone(sb.id, ownerId);

    /* ---- 会话内状态（每次 boot 重置） ---- */
    var session = null;      /* phoneSessions 记录 */
    var mode = 'found';      /* found 捡到这一幕 | lock | desktop | app | caught | ending */
    var endingInfo = null;   /* 收束画面文案 {k, t, s} */
    var shopTab = 'orders';   /* 淘宝页签 */
    var browserTab = 'search';/* 浏览器页签 */
    var healthTab = 'diet';   /* 健康页签 */
    var curApp = null;       /* 打开的 App（官方 id 或 custom:<安装id>） */
    var curInst = null;      /* curApp 是 custom: 时对应的工坊安装实例 */
    var curView = null;      /* app 内二级视图：真实会话 / 幕后详情 */
    var pinBuf = '';
    var pinLocked = false;   /* 连错 5 次设备暂锁 */
    var graceOpen = false;   /* 宽限期：他刚离开，屏幕还没锁（tryEnter 掷定） */
    var caughtInfo = null;   /* 被抓现场信息 {where, stage} */
    var pinMode = false;
    var healthDay = null;    /* 健康打卡当前选中的那天 */
    var noteQuery = '';      /* 备忘录搜索词 */
    var noteFolder = null;   /* 备忘录当前文件夹 */
    var msgQuery = '';       /* 消息搜索词 */
    var browserQuery = '';   /* 浏览器搜索词 */
    var shopQuery = '';      /* 淘宝搜索词 */

    var body = ctx.body;
      body.innerHTML = '';

      /* ---------- 捡到这一幕（Demo 08 的 found 页） ----------
         定案 §二：捡到入口是「捡手机文学成真了！你捡到了「{char}」落下的手机」
         +「偷看一下 / 放回原处」两个选项。没进入就不建会话、不留痕。 */
      function paintFound() {
        var root = h('div', 'ph-root ph-lock ph-found ph-wall-' + (ph.wallpaper % phone.WALLS.length));
        root.style.setProperty('--ph-accent', ph.accent);
        root.appendChild(h('h1', 'ph-found-t', '捡手机文学成真了。'));
        root.appendChild(h('p', 'ph-found-lead',
          '你捡到了「' + ch.name + '」落下的手机。屏幕还亮着，他似乎暂时没有回来。'));
        root.appendChild(h('div', 'ph-lock-time', timeStr()));
        root.appendChild(h('div', 'ph-lock-date', dateStr()));
        root.appendChild(noticeStack(false));
        root.appendChild(h('p', 'ph-lock-hint', '向上轻扫以打开'));
        root.appendChild(actionBtn('偷看一下', 'primary', tryEnter));
        root.appendChild(actionBtn('放回原处', 'ghost', function () {
          endingInfo = { k: '放回去了', t: '你把手机放回去了。',
            s: '屏幕暗下去，像是什么也没有发生。' };
          mode = 'ending'; paint();
        }));
        root.appendChild(h('p', 'ph-lock-hint', '这个选择可能会成为后来发生的事。'));
        body.appendChild(root);
      }

      /* ---------- 收束画面（Demo 08/10 的 ending） ---------- */
      function paintEnding() {
        var wall = ph.wallpaper % phone.WALLS.length;
        var root = h('div', 'ph-root ph-caught ph-wall-' + wall);
        root.style.setProperty('--ph-accent', ph.accent);
        var card = h('div', 'ph-caught-card');
        card.appendChild(h('p', 'ph-caught-k', (endingInfo && endingInfo.k) || '结束了'));
        card.appendChild(h('p', 'ph-caught-t', (endingInfo && endingInfo.t) || '你把手机放了回去。'));
        card.appendChild(h('p', 'ph-caught-s', (endingInfo && endingInfo.s) || ''));
        root.appendChild(card);
        root.appendChild(actionBtn('回到聊天', 'putback', putBack));
        body.appendChild(root);
      }

      /* ---------- 锁屏通知（Demo 09 的 noticeArea） ----------
         只放真实数据里真有的两件事：最近一条私聊消息（不泄露正文）、
         最近一次订单状态迁移。点开通知 = 一次行动，会留痕（清单 §行动消耗）。 */
      function noticeItems() {
        var out = [];
        var last = lastRealMsg();
        if (last) {
          out.push({ app: 'messages', title: chatNameOf(last.chat),
            at: last.msg && last.msg.timestamp, body: '发来了一条新消息' });
        }
        var orders = phone.listShop(ph.id).filter(function (o) { return (o.history || []).length; })
          .sort(function (a, b) { return b.at - a.at; });
        if (orders[0]) {
          var o = orders[0];
          var st = (o.history || [])[(o.history || []).length - 1];
          out.push({ app: 'taobao', title: '淘宝', at: st.at,
            body: (o.title || '订单') + ' · ' + (ORDER_STATUS_TXT[o.status] || o.status) });
        }
        if (!out.length) {
          out.push({ app: null, title: '系统', at: null, body: '一切如常' });
        }
        return out.slice(0, 2);
      }

      /* 通知堆：clickable=false 时是「还没决定要不要看」的静态预览 */
      function noticeStack(clickable) {
        var box = h('div', 'ph-notices');
        noticeItems().forEach(function (n) {
          var el = h(clickable && n.app ? 'button' : 'div', 'ph-lock-note');
          if (clickable && n.app) el.type = 'button';
          var head = h('div', 'ph-lock-note-h');
          head.appendChild(h('b', 'ph-lock-note-t', n.title));
          head.appendChild(h('span', 'ph-lock-note-at', n.at ? timeStr(n.at) : '现在'));
          el.appendChild(head);
          el.appendChild(h('p', 'ph-lock-note-b', n.body));
          if (clickable && n.app) {
            el.addEventListener('click', function () { openNotice(n.app); });
          }
          box.appendChild(el);
        });
        return box;
      }

      /* 打开通知：消耗行动 + 留痕，然后进对应的 App（Demo 09：
         「打开锁屏通知会直接前往对应 App，也可能改变未读或最近使用状态」）。
         锁着的时候（他上了锁、又不在宽限期）通知只能看预览 —— 打不开内容。 */
      function openNotice(app) {
        if (!canOpenNow()) {
          ctx.toast('手机锁着，通知只能看预览。', 'warn');
          if (!pinMode) { pinMode = true; paint(); }
          return;
        }
        if (!session) session = phone.startSession(ph, 'peek', lockOn() ? 'grace' : 'nopin');
        doAction('openNotice', { where: app, sensitivity: 1.5 }, function () {
          phone.addTrace(session, { type: 'recent', app: app,
            detail: '从锁屏打开了一条「' + (APP_LABEL[app] || app) + '」通知' });
          curApp = app; curInst = null; curView = null;
          mode = 'app'; paint();
        });
      }

      /* ---------- 会话与解锁 ---------- */

      function beginSession(entryType, unlockMethod) {
        session = phone.startSession(ph, entryType, unlockMethod);
        mode = 'desktop';
        curApp = null; curView = null;
        paint();
        /* 进入手机的兜底结算（架构 v1 §6.2C）：只做兜底，闸门
           （自主生活档位 + 最短间隔）说了算；后台跑，不阻塞进入。 */
        if (Sleepy.phoneAI) {
          try {
            if (phone.gateFor(ownerId).allowed) Sleepy.phoneAI.settle(sb.id, ownerId);
          } catch (e) { /* 后台结算失败不拦进入 */ }
        }
      }

      /* ---- 解锁的两个判据（都只从数据层问，页面里别自己拼）----
         lockOn()：他到底给不给手机上锁。判据在 phone.lockEnabled ——
         以前这里看的是「pin 存不存在」，而 pin 一直是派生好的、恒真，
         结果就是用户报的「角色没设密码，却显示输入密码解锁」（六.2）。
         canOpenNow()：现在能不能直接打开 —— 没设密码，或屏幕还亮着（宽限期）。 */
      function lockOn() {
        return !!(phone.lockEnabled && phone.lockEnabled(ph));
      }
      function canOpenNow() {
        return !lockOn() || graceOpen;
      }

      function tryEnter() {
        /* 入口分流（分流定案 §二）：
           longterm → 按授权直接进（authorized，不判定偷看）；
           peek + 首次（屏幕还亮着）→ 宽限期直进（留使用痕迹）；
           peek + 已锁定 → 密码分流。 */
        var long = phone.longPermFor(ph.id, 'all');
        if (long) {
          ph.lastExitedAt = null;
          phone.savePhone(ph);
          beginSession('longterm', 'longterm');
          return;
        }
        /* 宽限期掷骰（定案 §D）：首次必是「屏幕还亮着」；之后每次偷看，
           一半概率他刚好走开没锁 —— 世界感来自情境，不是固定机关。
           （他没设密码时这一掷用不上，见 canOpenNow。） */
        graceOpen = (ph.lastExitedAt == null) || Math.random() < 0.5;
        mode = 'lock';
        paint();
      }

      function unlockGrace() {
        if (!session) session = phone.startSession(ph, 'peek', 'grace');
        phone.addTrace(session, { type: 'recent', app: null, detail: '屏幕还亮着就拿起来了' });
        beginSession('peek', 'grace');
      }

      /* 他压根没设密码 → 直接翻开。
         照样建会话、照样留痕：「没有密码」不等于「可以随便看」
         （分流定案 §三·1：密码不需要，但锁屏这一屏要在 —— 「打开通知」
          这个行动只在这屏存在；§三·4：三个解锁概念不合并）。 */
      function unlockNoPin() {
        if (!session) session = phone.startSession(ph, 'peek', 'nopin');
        phone.addTrace(session, { type: 'recent', app: null, detail: '他没设密码，你直接翻开了' });
        beginSession('peek', 'nopin');
      }

      function unlockKnown() {
        if (!session) session = phone.startSession(ph, 'peek', 'pin_known');
        /* 知道密码 ≠ 获得允许：照样是未经允许查看，只是不用猜 */
        beginSession('peek', 'pin_known');
      }

      /* 「只看一眼」：停在锁屏看通知预览，不尝试、不进入（定案 §F）。
         没试过就不建会话 —— 未尝试通常不留记录。 */
      function onlyLook() {
        endingInfo = { k: '只看了一眼', t: '你停在锁屏，没有试密码。',
          s: '锁屏允许显示的内容就这些。你没有进入他的私人空间。' };
        mode = 'ending'; paint();
      }

      /* 收手退出（定案 §F）：试过就留着失败记录（已经落库），不额外补痕 */
      function giveUp() {
        endingInfo = {
          k: '收手了',
          t: session && session.pinFails ? '你在最后一刻收手了。' : '你把手机放回去了。',
          s: session && session.pinFails
            ? '没有进入桌面，但已经留下 ' + session.pinFails + ' 次失败尝试。'
            : '屏幕暗下去。你没有尝试密码，也没有进入他的私人空间。'
        };
        if (session) phone.endSession(session.id, 'giveup');
        mode = 'ending'; paint();
      }

      function submitPin() {
        /* 他没设密码时不该走到这里（面板也不渲染）。真走到了就直接放行，
           别停在一个「怎么输都错」的死路上。 */
        if (!lockOn()) return unlockNoPin();
        if (!session) session = phone.startSession(ph, 'peek', 'pin_guess');
        var ok = pinBuf === String((ph.lock && ph.lock.pin) || '');
        pinBuf = '';
        if (ok) {
          ph.knownPin = true;          /* 猜中 = user 从此知道密码（关系事实） */
          phone.savePhone(ph);
          beginSession('peek', 'pin_guess');
          return;
        }
        session = phone.recordPinFail(session.id);
        if (session.pinFails >= 5) {
          pinLocked = true;            /* 次数过多：设备暂时锁定（不是必抓机关） */
        }
        paint(true);
      }

      /* ---- 硬翻（方案-查手机硬翻-v1）----
         不知道密码时的第三条路：趁他不注意强行进。进入那一刻掷骰（phone.forceFlip），
         概率 = 基础档（user 可调）+ 情境加成（角色侧，不归 user 调）。
         硬要求（安乐拍的）：确认弹窗必须写明「可能会被 TA 发现」。 */
      function forceFlipFlow() {
        ui.confirm({
          title: '趁他不注意，硬翻？',
          note: '有被 TA 发现的风险 —— 被发现了会当场中断，TA 会知道你翻过。' +
            '（现在约 ' + Math.round(phone.flipProb(ph) * 100) + '%）',
          ok: '硬翻',
          danger: true
        }).then(function (yes) {
          if (!yes) return;
          var r = phone.forceFlip(ph);
          session = r.session;
          if (r.caught) {
            caughtInfo = { where: 'lock', stage: 3, force: true };
            mode = 'caught';
            paint();
            return;
          }
          mode = 'desktop';
          curApp = null; curView = null;
          paint();
          if (Sleepy.phoneAI && Sleepy.phoneAI.gateFor(ownerId).allowed) {
            try { Sleepy.phoneAI.settle(sb.id, ownerId); } catch (e) { /* 兜底结算不拦 */ }
          }
        });
      }

      /* 锁屏右上角的小设置浮层：硬翻风险三档（OOC 难度，安乐提议的概率可调）。
       * 放锁屏不放全局设置 app —— 调它的人就是正盯着锁屏犹豫的那个人。 */
      function flipGear() {
        var wrap = h('div', 'ph-flip-wrap');
        var btn = h('button', 'ph-flip-gear');
        btn.type = 'button';
        btn.setAttribute('aria-label', '硬翻风险设置');
        btn.innerHTML = ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>');
        btn.addEventListener('click', function () {
          var old = wrap.querySelector('.ph-flip-pop');
          if (old) { wrap.removeChild(old); return; }
          var pop = h('div', 'ph-flip-pop');
          pop.appendChild(h('p', 'ph-flip-pop-t', '硬翻风险'));
          var seg = h('div', 'seg');
          ['mild', 'standard', 'spicy'].forEach(function (k) {
            var b = h('button', 'seg-btn' + (phone.flipTier() === k ? ' is-on' : ''),
              phone.FLIP_TIER_LABELS[k]);
            b.type = 'button';
            b.addEventListener('click', function () {
              phone.setFlipTier(k);
              var kids = seg.querySelectorAll('.seg-btn');
              for (var i = 0; i < kids.length; i++) kids[i].classList.remove('is-on');
              b.classList.add('is-on');
              refreshProb();
            });
            seg.appendChild(b);
          });
          pop.appendChild(seg);
          var probLine = h('p', 'ph-flip-pop-note', '');
          pop.appendChild(probLine);
          pop.appendChild(h('p', 'ph-flip-pop-note',
            '基础风险是玩法难度。他刚放下手机、起过疑心时会更高 —— 那部分不归你调。'));
          function refreshProb() {
            probLine.textContent = '现在硬翻：约 ' +
              Math.round(phone.flipProb(ph) * 100) + '% 会被发现（含当前情境）。';
          }
          refreshProb();
          wrap.appendChild(pop);
        });
        wrap.appendChild(btn);
        return wrap;
      }

      /* ---------- 行动 ---------- */

      function doAction(action, o, after) {
        if (!session || session.authorized) { if (after) after(); return; }
        var r = phone.spendAction(session, action, o);
        session = phone.getSession(session.id);   /* 刷新快照，别拿旧对象继续算 */
        if (phone.maybeCaught(session, o)) {
          caughtInfo = { where: (o && o.where) || curApp || 'lock', stage: r.stage };
          mode = 'caught';
          paint();
          return;
        }
        if (after) after(r);
      }

      function openApp(key) {
        var inst = null;
        if (key.indexOf('custom:') === 0) {
          inst = (Sleepy.workshop ? Sleepy.workshop.installsOfPhone(ph.id) : [])
            .filter(function (i) { return i.id === key.slice(7); })[0];
          if (!inst) return;
        }
        doAction('openApp', { where: inst ? 'custom' : key }, function () {
          phone.addTrace(session, { type: 'recent', app: key,
            detail: '打开「' + (inst ? inst.templateName : APP_LABEL[key] || key) + '」' });
          curApp = key; curInst = inst; curView = null;
          mode = 'app';
          paint();
        });
      }

      function openRealChat(chat) {
        var deep = (chat.messages || []).length > 30;
        doAction('openChat', { where: 'messages' }, function () {
          phone.addTrace(session, { type: 'read', app: 'messages', detail: '看了「' + chatNameOf(chat) + '」的对话' });
          if (deep) {
            doAction('deepScroll', { where: 'messages' }, function () {
              phone.addTrace(session, { type: 'location', app: 'messages', detail: '往前翻了旧记录' });
              curView = { kind: 'real', chat: chat };
              paint();
            });
          } else {
            curView = { kind: 'real', chat: chat };
            paint();
          }
        });
      }

      function openDerived(m) {
        var act = m.kind === 'draft' ? 'openDraft' : 'openDerived';
        doAction(act, { where: 'messages', sensitivity: 2 }, function () {
          phone.addTrace(session, { type: 'read', app: 'messages', detail: '看了' + (m.kind === 'draft' ? '草稿' : '幕后交流'), detectable: true });
          curView = { kind: 'derived', item: m };
          paint();
        });
      }

      /* 群聊只读视图（v247b，按账号视角渲染）：从这部手机的主人（本体）
         看——TA 自己发出的消息在右，别人的在左；发送者用群成员的展示名
         （accountMeta），系统消息居中。只读，composer 照旧摆着不可发。 */
      function openGroupChat(g) {
        var msgs = Sleepy.groupStore.messagesOf(g.id);
        var deep = msgs.length > 30;
        doAction('openChat', { where: 'messages' }, function () {
          phone.addTrace(session, { type: 'read', app: 'messages', detail: '看了「' + g.name + '」的群聊' });
          if (deep) {
            doAction('deepScroll', { where: 'messages' }, function () {
              phone.addTrace(session, { type: 'location', app: 'messages', detail: '往前翻了群里的旧记录' });
              curView = { kind: 'group', group: g };
              paint();
            });
          } else {
            curView = { kind: 'group', group: g };
            paint();
          }
        });
      }

      function putBack() {
        /* 已经收束过的会话（收手/只看一眼）不再二次落 endedAt */
        if (session && !phone.getSession(session.id).endedAt) {
          phone.endSession(session.id, caughtInfo ? 'caught' : 'putback');
        }
        ctx.back();
      }

      /* ---------- 渲染 ---------- */

      function paint(keepPin) {
        if (!keepPin) pinBuf = '';
        body.innerHTML = '';

        if (mode === 'caught') return paintCaught();
        if (mode === 'ending') return paintEnding();
        if (mode === 'found') return paintFound();
        if (mode === 'lock') return paintLock();
        if (mode === 'app') return paintApp();
        return paintDesktop();
      }

      /* ----- 锁屏（同壁纸加深色纱，Demo 的 lock 那层） -----
         ⚠️ 「他没设密码」时这一屏**照样要在**（分流定案 §三·1：「打开通知」
         这个行动只在这屏存在），要区别的不是「有没有这一屏」，而是
         「要不要输密码」。用户六.2 报的就是没区分后者。 */
      function paintLock() {
        var root = h('div', 'ph-root ph-lock ph-wall-' + (ph.wallpaper % phone.WALLS.length));
        root.style.setProperty('--ph-accent', ph.accent);

        root.appendChild(h('div', 'ph-lock-time', timeStr()));
        root.appendChild(h('div', 'ph-lock-date', dateStr()));
        root.appendChild(flipGear());

        var locked = lockOn();
        var openNow = canOpenNow();

        /* 锁屏通知预览：真实数据的影子（消息的存在本身 + 订单状态迁移），
           点开 = 一次行动 + 一条痕迹（Demo 09）。
           能不能点看 openNow：没密码的手机不存在「锁着」这个状态。 */
        root.appendChild(noticeStack(!pinMode && openNow));
        if (!pinMode) {
          root.appendChild(h('p', 'ph-lock-hint', pinLocked ? '手机已锁定' :
            !locked ? '他没有设锁屏密码' :
            openNow ? '屏幕尚未自动锁定' : '向上轻扫并输入密码'));
        }

        if (pinLocked) {
          root.appendChild(h('p', 'ph-lock-warn', '密码错误次数太多，手机被暂时锁定了。'));
          root.appendChild(actionBtn('放回手机', 'ghost', giveUp));
        } else if (!locked) {
          /* 没设密码：**一个「输入密码」的入口都不出现** —— 没有码可输。
             剩下的摩擦照旧（行动消耗 / 痕迹 / 风险 / 当场被抓），
             不是「没密码就等于随便看」。 */
          if (!pinMode) {
            root.appendChild(actionBtn('向上打开', 'primary', unlockNoPin));
            root.appendChild(actionBtn('只看一眼，然后放回去', 'ghost', onlyLook));
          }
          root.appendChild(actionBtn('放回原处', 'putback', giveUp));
        } else if (openNow) {
          /* 宽限期（定案 §D）：不需要密码 ≠ 获得允许，进来照样留痕。
             ⚠️ 这条只在**他确实上了锁**时才有意义：有锁 + 屏幕还亮着，
             可以「向上打开」进去，也可以老老实实输密码。 */
          if (!pinMode) {
            root.appendChild(actionBtn('向上打开', 'primary', unlockGrace));
            root.appendChild(actionBtn('输入密码解锁', 'ghost', function () { pinMode = true; paint(); }));
            if (ph.knownPin) {
              root.appendChild(actionBtn('使用你记得的密码', 'ghost', unlockKnown));
            }
          }
          root.appendChild(actionBtn('放回原处', 'putback', giveUp));
        } else {
          if (!pinMode) {
            root.appendChild(actionBtn('输入密码解锁', 'primary', function () { pinMode = true; paint(); }));
            if (ph.knownPin) {
              root.appendChild(actionBtn('使用你记得的密码', 'ghost', unlockKnown));
            }
            /* 硬翻：不知道密码时赌一把。按钮放 ghost 位偏下、文案带画面感，
               真正的风险提示在确认弹窗里（那是硬要求，不能省）。 */
            root.appendChild(actionBtn('趁他不注意，硬翻', 'danger', forceFlipFlow));
            /* 定案 §F：不试密码也能收手 —— 停在锁屏只看预览 */
            root.appendChild(actionBtn('只看一眼，然后放回去', 'ghost', onlyLook));
          }
          root.appendChild(actionBtn('放回原处', 'putback', giveUp));
        }

        /* 只有真的上了锁才可能走到输入面板 —— 没锁时 pin 是空的，
           画出来就是一条「怎么输都错」的死路（审查报告六.2 第 5 条）。 */
        if (pinMode && locked && !pinLocked) {
          root.appendChild(pinPad());
        }
        if (session && session.pinFails > 0 && !pinMode) {
          root.appendChild(riskTrack());
        }
        body.appendChild(root);
      }

      /* 风险条（Demo 10 的 riskTrack）：行动越多越满，配一句环境提示。
         授权查看恒平静 —— 授权不触发偷看判定（分流定案 §三·4）。 */
      function riskTrack() {
        var stage = session ? (session.riskStage || 0) : 0;
        var box = h('div', 'ph-risktrack');
        var head = h('div', 'ph-risk-head');
        head.appendChild(h('b', null, session && session.authorized ? '他请你看的' : '周围的动静'));
        head.appendChild(h('span', 'ph-risk-at',
          session && session.pinFails ? '已尝试 ' + session.pinFails + ' 次' : RISK_WORDS[stage]));
        box.appendChild(head);
        var track = h('div', 'ph-risk-track');
        var fill = h('div', 'ph-risk-fill');
        fill.style.width = (session && session.authorized ? 8 : [12, 39, 70, 100][Math.min(stage, 3)]) + '%';
        track.appendChild(fill);
        box.appendChild(track);
        var hint = phone.hintOf(stage);
        box.appendChild(h('p', 'ph-risk-text',
          session && session.authorized ? '本次查看不会触发偷看事件。'
            : (hint || '门外很安静，你还有时间改变主意。')));
        return box;
      }

      function pinPad() {
        var box = h('div', 'ph-pin');
        box.appendChild(h('h3', 'ph-pin-t', '输入密码'));
        box.appendChild(h('p', 'ph-pin-s',
          ph.knownPin ? '这串数字是他过去亲口告诉你的。'
                      : '你想起几个他可能会使用的数字。'));
        var dots = h('div', 'ph-pin-dots');
        function paintDots() {
          dots.innerHTML = '';
          for (var i = 0; i < 4; i++) {
            dots.appendChild(h('i', 'ph-pin-dot' + (i < pinBuf.length ? ' is-on' : '')));
          }
        }
        paintDots();
        /* 候选密码（定案 §E）：只由真实关系事实生成 —— 岛落成日 / 首次聊天
           的日子。点了直接试，每次同样消耗行动、留下失败记录。 */
        var cands = phone.pinCandidates(sb.id, ownerId);
        if (cands.length) {
          var cr = h('div', 'ph-pin-cands');
          cands.forEach(function (c) {
            var cb = h('button', 'ph-cand');
            cb.type = 'button';
            cb.appendChild(h('b', null, c.label));
            cb.appendChild(h('small', null, c.value.slice(0, 2) + '月' + c.value.slice(2) + '日'));
            cb.addEventListener('click', function () {
              pinBuf = c.value;
              paintDots();
              setTimeout(submitPin, 160);
            });
            cr.appendChild(cb);
          });
          box.appendChild(cr);
        }
        box.appendChild(dots);
        var grid = h('div', 'ph-pad');
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach(function (k) {
          if (k === '') { grid.appendChild(h('span', 'ph-pad-blank')); return; }
          var b = h('button', 'ph-pad-key', k);
          b.type = 'button';
          b.addEventListener('click', function () {
            if (k === '⌫') { pinBuf = pinBuf.slice(0, -1); paintDots(); return; }
            if (pinBuf.length >= 4) return;
            pinBuf += k;
            paintDots();
            if (pinBuf.length === 4) setTimeout(submitPin, 140);
          });
          grid.appendChild(b);
        });
        box.appendChild(grid);
        /* 自输四位数字（定案 §E） */
        var cu = h('div', 'ph-pin-custom');
        var cin = h('input', 'ph-pin-input');
        cin.type = 'text';
        cin.inputMode = 'numeric';
        cin.maxLength = 4;
        cin.placeholder = '自己输入四位数字';
        cin.addEventListener('input', function () {
          cin.value = cin.value.replace(/\D/g, '').slice(0, 4);
        });
        var cbtn = h('button', 'ph-pin-try', '尝试');
        cbtn.type = 'button';
        cbtn.addEventListener('click', function () {
          if (cin.value.length !== 4) return;
          pinBuf = cin.value;
          cin.value = '';
          paintDots();
          setTimeout(submitPin, 160);
        });
        cu.appendChild(cin);
        cu.appendChild(cbtn);
        box.appendChild(cu);
        box.appendChild(riskTrack());
        var stop = h('button', 'ph-pin-stop', '不试了，趁现在放回去');
        stop.type = 'button';
        stop.addEventListener('click', giveUp);
        box.appendChild(stop);
        var cancel = h('button', 'ph-pin-cancel', '还是算了吧');
        cancel.type = 'button';
        cancel.addEventListener('click', function () { pinMode = false; paint(); });
        box.appendChild(cancel);
        return box;
      }

      /* ----- 私人桌面（照 Demo：问候 + 双组件 + 图标砖） ----- */
      function paintDesktop() {
        var root = h('div', 'ph-root ph-desk ph-wall-' + (ph.wallpaper % phone.WALLS.length));
        root.style.setProperty('--ph-accent', ph.accent);

        /* 问候语：时段 + 一句来自真实数据的副行 */
        var hr = new Date().getHours();
        var greet = hr < 5 ? '夜深了' : hr < 11 ? '早上好' : hr < 14 ? '中午好' : hr < 18 ? '下午好' : '晚上好';
        var livePlan = plansLive();
        var hero = h('div', 'ph-hero');
        hero.appendChild(h('h1', 'ph-hero-t', greet));
        hero.appendChild(h('p', 'ph-hero-s',
          livePlan ? '他最近在准备：' + livePlan.title : dateStr() + ' · 手机就放在那里'));

        /* ★ 2026-10-10 首页右上角「刷新」：一次整体结算（原本的 phoneLife
           协议卡），产出跨 App 的几页内容 —— 各 App 页里还有各自的刷新。 */
        var refresh = h('button', 'ph-refresh');
        refresh.type = 'button';
        refresh.setAttribute('aria-label', '刷新他的生活');
        refresh.innerHTML = ic('<path d="M20 11.5a8 8 0 1 1-2.3-5.8"/><path d="M20 4.5v5.5h-5.5"/>');
        refresh.addEventListener('click', function () {
          if (!Sleepy.phoneAI) { ctx.toast('生成链还没加载', 'err'); return; }
          refresh.disabled = true;
          refresh.classList.add('is-spin');
          ctx.toast('正在翻他最近的生活…', 'ok');
          Sleepy.phoneAI.settle(sb.id, ownerId, { force: true }).then(function (r) {
            paint();
            refresh.disabled = false;
            refresh.classList.remove('is-spin');
            if (r.ok && r.stat && r.stat.applied > 0) {
              ctx.toast('他的生活往前走了一点（' + r.stat.applied + ' 条新痕迹）', 'ok');
            } else if (r.ok) {
              /* 2026-10-23：手动刷新已带一轮自动补写，两轮都空才到这里 ——
                 如实说 + 给下一步（顺手修：原来不恢复按钮，转圈卡死）。 */
              ctx.toast('模型两轮都没写出新东西，稍后再刷新一次试试', 'warn');
            } else {
              ctx.toast(r.reason || r.error || '没刷新出来', 'warn');
            }
          });
        });
        hero.appendChild(refresh);
        root.appendChild(hero);

        /* 组件行：左 = 进行中的计划（真实 charPlan），右 = 与你的最近聊天 */
        var wr = h('div', 'ph-widgets');
        var wPlan = h('div', 'ph-widget');
        wPlan.appendChild(h('span', 'ph-widget-t', '进行中的计划'));
        wPlan.appendChild(h('span', 'ph-widget-v', livePlan ? livePlan.title : '没有特别安排'));
        wPlan.appendChild(h('span', 'ph-widget-s',
          livePlan ? PLAN_STATUS_TXT[livePlan.status] || livePlan.status : '日子照常过'));
        wr.appendChild(wPlan);
        var last = lastRealMsg();
        var wChat = h('div', 'ph-widget is-photo');
        wChat.appendChild(h('span', 'ph-widget-t', '与你的聊天'));
        wChat.appendChild(h('span', 'ph-widget-v',
          last ? timeStr(last.msg && last.msg.timestamp || last.chat.updatedAt) : '—'));
        wChat.appendChild(h('span', 'ph-widget-s',
          last ? previewMsg(last.msg) : '还没有说过话'));
        wr.appendChild(wChat);
        root.appendChild(wr);

        /* 主人条（Demo 08 的 ownerBar）：谁的手机 + 当下情境 + 访问性质。
           「未经允许 / 已授权查看」来自会话的 authorized，不是自己编的。 */
        var owner = h('div', 'ph-ownerbar');
        owner.appendChild(h('b', 'ph-owner-name', ch.name + ' 的手机'));
        var stageN = session ? (session.riskStage || 0) : 0;
        owner.appendChild(h('small', 'ph-owner-note',
          session && session.authorized ? '他知道你正在这里'
            : (phone.hintOf(stageN) || '门外暂时没有动静')));
        var access = h('span', 'ph-owner-access', session && session.authorized
          ? (session.entryType === 'invite' ? '他请你看的' : '已授权查看')
          : '未经允许');
        owner.appendChild(access);
        root.appendChild(owner);

        var grid = h('div', 'ph-grid');
        var cells = [];
        (ph.appOrder || []).forEach(function (app) {
          /* 老存档里可能还躺着已经撤掉的 App（比如 calendar）——
             按 PHONE_APPS 过一遍，桌面上就不会留下一个点不开的图标。
             存档本身不动：这里只是「显示哪些」。 */
          if (PHONE_APPS.indexOf(app) < 0) return;
          cells.push({ key: app, label: APP_LABEL[app] || app, icon: APP_IC[app] || '', glyph: null });
        });
        /* 工坊装出去的自定义 App（第 4 批）：跟在官方 App 后面 */
        var installs = Sleepy.workshop ? Sleepy.workshop.installsOfPhone(ph.id) : [];
        installs.forEach(function (inst) {
          cells.push({ key: 'custom:' + inst.id, label: inst.templateName,
            icon: '', glyph: (Sleepy.workshop.TEMPLATE_TYPES[inst.templateType] || {}).icon || '▤',
            accent: inst.color });
        });
        /* 被「暂时隐藏」的 App（权限 state=hidden，总纲 §9）：桌面锁上，
           入口还在但打不开 —— 不是数据删除，是权限变化。 */
        var hidden = phone.hiddenApps(ph.id);
        var hiddenAll = hidden.apps.indexOf('all') >= 0;
        cells.forEach(function (cell) {
          var locked = hiddenAll || hidden.apps.indexOf(cell.key) >= 0;
          var b = h('button', 'ph-app' + (locked ? ' is-locked' : ''));
          b.type = 'button';
          /* ui.h 第三参是纯文本 —— SVG 必须 innerHTML（日记波纹轮的老坑）。
             自定义 App 用字符徽记 + 模板强调色 */
          var icEl = h('span', 'ph-app-ic' + (cell.glyph ? ' is-custom' : ''));
          if (cell.glyph) { icEl.textContent = cell.glyph; if (cell.accent) icEl.style.color = cell.accent; }
          else icEl.innerHTML = cell.icon;
          b.appendChild(icEl);
          if (locked) {
            var lk = h('span', 'ph-app-lock');
            /* 线稿锁（emoji 会上色，跟这套线稿语言不搭） */
            lk.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" ' +
              'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
              '<path d="M8 11V8a4 4 0 0 1 8 0v3"/><rect x="6" y="11" width="12" height="9" rx="2"/></svg>';
            b.appendChild(lk);
          }
          b.appendChild(h('span', 'ph-app-name', cell.label));
          b.addEventListener('click', function () {
            if (locked) {
              ctx.toast('他暂时把「' + cell.label + '」藏起来了。', 'warn');
              return;
            }
            openApp(cell.key);
          });
          grid.appendChild(b);
        });
        root.appendChild(grid);

        /* 权限说明面板 + 风险 + 放回手机：全部推到底部（Demo 02 的 dock 位置）。
           上面留白撑开，屏幕才不会「全挤在上面」。 */
        var foot = h('div', 'ph-desk-foot');
        if (hidden.apps.length) {
          var pemBox = h('div', 'ph-perm-note');
          pemBox.appendChild(h('b', null, '他暂时藏起了一点秘密'));
          var names = hiddenAll ? ['全部 App']
            : hidden.apps.map(function (a) { return APP_LABEL[a] || a; });
          pemBox.appendChild(h('span', null, names.join('、') + '暂时不可查看。' +
            (hidden.reason ? '（他的说法：' + hidden.reason + '）' : '')));
          foot.appendChild(pemBox);
        }
        foot.appendChild(riskTrack());
        var dock = h('div', 'ph-desk-dock');
        var put = h('button', 'ph-btn ph-btn-primary', '放回手机');
        put.type = 'button';
        put.addEventListener('click', putBack);
        dock.appendChild(put);
        foot.appendChild(dock);
        root.appendChild(foot);
        body.appendChild(root);
      }

      /* 计划状态文案见模块级 PLAN_STATUS_TXT（入口页/桌面共用一份） */
      function plansLive() {
        var list = phone.plansOf(ph.id).filter(function (p) {
          return ['preparing', 'scheduled', 'brewing'].indexOf(p.status) >= 0;
        });
        list.sort(function (a, b) {
          var w = { scheduled: 0, preparing: 1, brewing: 2 };
          return w[a.status] - w[b.status] || b.updatedAt - a.updatedAt;
        });
        return list[0] || null;
      }

      /* ----- App 内容 ----- */
      function paintApp() {
        var wall = ph.wallpaper % phone.WALLS.length;
        var appKey = curInst ? 'custom' : curApp;
        var root = h('div', 'ph-root ph-appview is-app-' + appKey + ' ph-wall-' + wall);
        root.style.setProperty('--ph-accent', ph.accent);

        /* Demo 的 context 条：一眼看清「这是谁的手机、看的是什么」，
           顺带把环境提示放在这里（App 里不再单独占一条风险条）。 */
        if (curApp && !curView) {
          var stageC = session ? (session.riskStage || 0) : 0;
          var hintC = session && session.authorized ? '' : phone.hintOf(stageC);
          var ctxBar = h('p', 'ph-context', '正在看 ' + ch.name + ' 的「' +
            (curInst ? curInst.templateName : APP_LABEL[curApp] || '') + '」' +
            (hintC ? ' · ' + hintC : ''));
          root.appendChild(ctxBar);
        }

        var head = h('div', 'ph-app-head');
        var back = h('button', 'ph-app-back', '‹');
        back.type = 'button';
        back.addEventListener('click', function () {
          /* 两层返回：会话详情 → App 列表 → 桌面。
             第一版直接跳桌面，把列表层整个跳过了 —— 真机跑出来的。 */
          if (curView) { curView = null; paint(); return; }
          mode = 'desktop'; curApp = null; paint();
        });
        head.appendChild(back);
        head.appendChild(h('span', 'ph-app-title',
          curView && curView.kind === 'real' ? chatNameOf(curView.chat) :
          curView && curView.kind === 'group' ? curView.group.name :
          curView ? (curView.item.kind === 'draft' ? '草稿' : '幕后交流') :
          curInst ? curInst.templateName : APP_LABEL[curApp] || ''));
        /* ★ 2026-10-10 App 页右上角刷新：单 App 专属提示词
           （phoneLife 协议卡 + [FOCUS] 该 App 的指令 + [EXIST] 防重复）。
           只在列表层给（进了会话详情/自定义 App 不给）。 */
        if (!curView && !curInst && curApp && PHONE_APPS.indexOf(curApp) >= 0) {
          var appRefresh = h('button', 'ph-refresh ph-refresh-app');
          appRefresh.type = 'button';
          appRefresh.setAttribute('aria-label', '刷新「' + (APP_LABEL[curApp] || '') + '」');
          appRefresh.innerHTML = ic('<path d="M20 11.5a8 8 0 1 1-2.3-5.8"/><path d="M20 4.5v5.5h-5.5"/>');
          appRefresh.addEventListener('click', function () {
            if (!Sleepy.phoneAI || !Sleepy.phoneAI.refreshApp) { ctx.toast('生成链还没加载', 'err'); return; }
            appRefresh.disabled = true;
            appRefresh.classList.add('is-spin');
            ctx.toast('正在写「' + (APP_LABEL[curApp] || '') + '」的新动静…', 'ok');
            Sleepy.phoneAI.refreshApp(sb.id, ownerId, curApp).then(function (r) {
              paint();
              appRefresh.disabled = false;
              appRefresh.classList.remove('is-spin');
              if (r.ok && r.stat && r.stat.applied > 0) {
                ctx.toast('「' + (APP_LABEL[curApp] || '') + '」多了 ' + r.stat.applied + ' 条', 'ok');
              } else if (r.ok) {
                /* 2026-10-23：刷新链已带一轮自动补写，到这里是两轮都没落成 ——
                   如实说 + 给下一步，别再甩一句「没有新动静」让人以为是对的。
                   （顺手修：原来失败也不恢复按钮，转圈卡死。） */
                ctx.toast((r.stat && r.stat.dropped > 0)
                  ? '模型写了 ' + r.stat.dropped + ' 条但都没过校验，再点一次刷新试试'
                  : '模型两轮都没写出新东西，稍后再刷新一次试试', 'warn');
              } else {
                ctx.toast(r.reason || r.error || '没刷新出来', 'warn');
              }
            });
          });
          head.appendChild(appRefresh);
        }
        root.appendChild(head);

        if (curInst) paintCustomApp(root, curInst);
        else if (curApp === 'messages') {
          if (curView && curView.kind === 'real') paintRealChat(root, curView.chat);
          else if (curView && curView.kind === 'group') paintGroupChat(root, curView.group);
          else if (curView) paintDerived(root, curView.item);
          else paintMsgList(root);
        } else if (curApp === 'notes') {
          if (curView && curView.kind === 'note') paintNoteDetail(root, curView.item);
          else paintNotes(root);
        } else if (curApp === 'browser') paintBrowser(root);
        else if (curApp === 'health') paintHealth(root);
        else if (curApp === 'taobao') {
          if (curView && curView.kind === 'order') paintOrderDetail(root, curView.item);
          else {
            paintShop(root);
            /* 照 Demo 的 bottomNav：磨砂底 + 线性图标 + 焦糖选中（方块 nav） */
            var nav = h('div', 'ph-bottomnav');
            [{ v: 'orders', label: '订单',
               ic: '<path d="M6 4h12v16H6zM9 8h6M9 12h6"/>' },
             { v: 'favs', label: '收藏',
               ic: '<path d="M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4-3.9 5.5-.8z"/>' },
             { v: 'cart', label: '购物车',
               ic: '<path d="M5 6h2l2 10h8l2-7H8M10 20h.01M17 20h.01"/>' }].forEach(function (it) {
              var b = h('button', 'ph-bn' + (shopTab === it.v ? ' is-on' : ''));
              b.type = 'button';
              var icEl = h('span', 'ph-bn-ic');
              icEl.innerHTML = ic(it.ic);
              b.appendChild(icEl);
              b.appendChild(h('span', null, it.label));
              b.addEventListener('click', function () { shopTab = it.v; paint(); });
              nav.appendChild(b);
            });
            root.appendChild(nav);
          }
        }
        else {
          /* 相册由独立 App 承担（char 侧实例接入在后面批次），先如实空态。
             日历已经**整个撤出查手机**（它变成了桌面第 3 屏的独立 App），
             所以这里再也走不到 calendar 这一支。 */
          root.appendChild(emptyBlock(
            (APP_LABEL[curApp] || '这里') + '还是空的',
            APP_EMPTY[curApp] || '他还没有在这里留下什么。'));
        }
        body.appendChild(root);
      }

      /* 消息列表：真实聊天（镜像）+ 幕后交流 + 草稿。
         Demo 06：搜索行 → 分段（幕后/群聊/最近会话/草稿），会话行右侧是时间。 */
      function paintMsgList(root) {
        var list = h('div', 'ph-msgs');

        /* 搜索（Demo 的 search 行）：真实过滤名字与最后一条消息 */
        var sIn = h('input', 'ph-search');
        sIn.placeholder = '搜索联系人与聊天记录';
        sIn.value = msgQuery || '';
        sIn.addEventListener('input', function () { msgQuery = sIn.value; paint(); });
        root.appendChild(sIn);
        var q = (msgQuery || '').trim().toLowerCase();
        function hit(name, preview) {
          if (!q) return true;
          return String(name || '').toLowerCase().indexOf(q) >= 0 ||
            String(preview || '').toLowerCase().indexOf(q) >= 0;
        }

        var derived = phone.derivedMsgs(ph.id).sort(function (a, b) { return b.at - a.at; });
        var drafts = derived.filter(function (m) { return m.kind === 'draft'; });
        var behind = derived.filter(function (m) { return m.kind !== 'draft'; });

        /* 真实聊天：user-char 私聊（含皮套账号）+ 本体参加的群聊 */
        var realChats = (Sleepy.chatStore ? Sleepy.chatStore.getChats() : [])
          .filter(function (c) { return core.rootIdOf(c.characterId) === ownerId; })
          .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        var groups = [];
        if (Sleepy.groupStore) {
          groups = Sleepy.groupStore.listGroups().filter(function (g) {
            return Sleepy.groupStore.membersOf(g.id).some(function (m) {
              return core.rootIdOf(m.ownerId) === ownerId;
            });
          });
        }

        if (behind.length) {
          var shown = behind.filter(function (m) {
            return hit(m.withName || '备忘', (m.lines || []).map(function (l) { return l.text; }).join(' '));
          });
          if (shown.length) {
            list.appendChild(sectionLabel('幕后交流'));
            shown.forEach(function (m) { list.appendChild(derivedRow(m)); });
          }
        }
        if (groups.length) {
          var gs = groups.filter(function (g) {
            var last = Sleepy.groupStore.lastMessage(g.id);
            return hit(g.name, previewGroup(last));
          });
          if (gs.length) {
            list.appendChild(sectionLabel('群聊'));
            gs.forEach(function (g) {
              var last = Sleepy.groupStore.lastMessage(g.id);
              list.appendChild(row(g.name, previewGroup(last), last ? last.at : g.createdAt, function () {
                openGroupChat(g);
              }));
            });
          }
        }
        var rc = realChats.filter(function (c) {
          var last = (c.messages || [])[c.messages.length - 1];
          return hit(chatNameOf(c), previewMsg(last));
        });
        if (rc.length) {
          list.appendChild(sectionLabel('最近会话'));
          rc.forEach(function (c) {
            var last = (c.messages || [])[c.messages.length - 1];
            list.appendChild(row(chatNameOf(c), previewMsg(last), c.updatedAt, function () {
              openRealChat(c);
            }));
          });
        }
        if (drafts.length) {
          list.appendChild(sectionLabel('未发送的草稿'));
          drafts.forEach(function (m) { list.appendChild(derivedRow(m)); });
        }
        if (!list.children.length) {
          list.appendChild(emptyBlock(
            q ? '没搜到「' + msgQuery + '」' : '他还没有开始用这部手机聊天',
            q ? '换个词试试。' : '手机里只会有他真实发生过的对话。'));
        }
        root.appendChild(list);
      }

      function sectionLabel(t) { return h('div', 'ph-sec', t); }
      /* 空态块（照 Demo 的 .empty）：空也要看得出是「设计过的空」——
         一句「这里暂时没有」，加一句为什么没有。 */
      function emptyBlock(title, why) {
        var box = h('div', 'ph-empty');
        box.appendChild(h('b', null, title));
        if (why) box.appendChild(h('span', null, why));
        return box;
      }

      var ROW_TINTS = ['#E8DCC8', '#EAD6CE', '#DCE2D4', '#E5DFD2', '#E3D8DA'];
      function row(name, preview, at, onClick) {
        var r = h('button', 'ph-row');
        r.type = 'button';
        /* 照 Demo 的会话行：头像圈 + 名字/预览 + 日期 */
        var av = h('span', 'ph-row-ava', (name || '?').slice(0, 1));
        av.style.background = ROW_TINTS[phone.hashOf(name) % ROW_TINTS.length];
        r.appendChild(av);
        var mid = h('div', 'ph-row-mid');
        mid.appendChild(h('span', 'ph-row-name', name));
        mid.appendChild(h('span', 'ph-row-preview', preview || ' '));
        r.appendChild(mid);
        r.appendChild(h('span', 'ph-row-time', at ? dateStrOf(at) : ''));
        r.addEventListener('click', onClick);
        return r;
      }

      function derivedRow(m) {
        var label = m.kind === 'draft'
          ? '（没发出去）' + (m.title || (m.lines[0] && m.lines[0].text) || '')
          : (m.withName || '备忘') + ' · ' + (m.title || '');
        return row(label, m.lines.length ? m.lines[m.lines.length - 1].text : '',
          m.at, function () { openDerived(m); });
      }

      /* 真实会话只读视图：从 char 的手机看，user 的消息在左（收到的），char 的在右。
         Demo 06：detailHead（头像 + 名字 + 关系说明）+ 气泡带时间 + 只读输入框。 */
      function paintRealChat(root, chat) {
        var uName = userNameOf(chat);
        var cName = chatNameOf(chat);
        var dhead = h('div', 'ph-dhead');
        var dava = h('span', 'ph-row-ava ph-row-ava-big', cName.slice(0, 1));
        dava.style.background = ROW_TINTS[phone.hashOf(cName) % ROW_TINTS.length];
        dhead.appendChild(dava);
        var dmid = h('div', 'ph-dhead-mid');
        dmid.appendChild(h('p', 'ph-dhead-t', cName));
        dmid.appendChild(h('p', 'ph-dhead-s', '和你的对话 · ' +
          (chat.messages || []).filter(function (m) { return m.role !== 'system'; }).length + ' 条'));
        dhead.appendChild(dmid);
        root.appendChild(dhead);
        var list = h('div', 'ph-bubbles');
        (chat.messages || []).forEach(function (m) {
          if (m.role === 'system') return;
          var mine = m.role !== 'user';
          var line = h('div', 'ph-bline' + (mine ? ' is-mine' : ''));
          line.appendChild(h('span', 'ph-bwho', mine ? cName : uName));
          var bub = h('div', 'ph-bubble' + (m.recalledAt ? ' is-recalled' : ''));
          bub.appendChild(h('span', null, bubbleText(m)));
          if (m.timestamp) bub.appendChild(h('small', 'ph-bubble-at', timeStr(m.timestamp)));
          line.appendChild(bub);
          list.appendChild(line);
        });
        if (!(chat.messages || []).length) {
          list.appendChild(h('p', 'ph-empty-t', '这段对话还没有消息。'));
        }
        root.appendChild(list);
        root.appendChild(roComposer());
      }

      /* 群聊只读视图（v247b）：视角 = 这部手机的主人。
         「是不是自己发的」用消息上的 senderEntityId 对 ownerId 判——
         落库时已经归一（user 恒 'user' / char 顺 rootOf / NPC 是自己），
         不在渲染时猜。群成员展示名走 accountMeta（查不到回落 '?'，
         和群聊本体页同一套，不长第二张脸）。 */
      function paintGroupChat(root, g) {
        var msgs = Sleepy.groupStore.messagesOf(g.id);
        var members = Sleepy.groupStore.membersOf(g.id, true);
        var dhead = h('div', 'ph-dhead');
        var dava = h('span', 'ph-row-ava ph-row-ava-big', g.name.slice(0, 1));
        dava.style.background = ROW_TINTS[phone.hashOf(g.name) % ROW_TINTS.length];
        dhead.appendChild(dava);
        var dmid = h('div', 'ph-dhead-mid');
        dmid.appendChild(h('p', 'ph-dhead-t', g.name));
        dmid.appendChild(h('p', 'ph-dhead-s', '群聊 · ' +
          Sleepy.groupStore.membersOf(g.id).length + ' 个成员 · ' + msgs.length + ' 条'));
        dhead.appendChild(dmid);
        root.appendChild(dhead);

        var list = h('div', 'ph-bubbles');
        msgs.forEach(function (m) {
          if (m.type === 'system' || m.senderKind === 'system') {
            list.appendChild(h('div', 'ph-sysline', m.content || ''));
            return;
          }
          var member = null;
          for (var i = 0; i < members.length; i++) {
            if (members[i].accountId === m.senderAccountId) { member = members[i]; break; }
          }
          var meta = Sleepy.groupStore.accountMeta(member);
          /* 回撤的群消息照私聊口径显示「撤回了一条消息」—— 事实记录在案 */
          var recalled = !!m.recalledAt;
          var mine = m.senderEntityId === ownerId;
          var line = h('div', 'ph-bline' + (mine ? ' is-mine' : ''));
          line.appendChild(h('span', 'ph-bwho', mine ? (ch.name || '我') : meta.name));
          var bub = h('div', 'ph-bubble' + (recalled ? ' is-recalled' : ''));
          var body = recalled ? '撤回了一条消息'
            : (m.content || (m.mediaId ? '（一张图）' : (m.url ? '（一个表情包）' : '')));
          bub.appendChild(h('span', null, body));
          if (m.createdAt) bub.appendChild(h('small', 'ph-bubble-at', timeStr(m.createdAt)));
          line.appendChild(bub);
          list.appendChild(line);
        });
        if (!msgs.length) {
          list.appendChild(h('p', 'ph-empty-t', '这个群里还没有消息。'));
        }
        root.appendChild(list);
        root.appendChild(roComposer());
      }

      /* 只读输入框（Demo 06 的 composer）：这是他的手机，user 只能看 ——
         输入框存在这件事本身就是要展示的东西，但不可写、不可发。 */
      function roComposer() {
        var box = h('div', 'ph-composer');
        var fake = h('div', 'ph-composer-in', '这是他的输入框');
        box.appendChild(fake);
        var send = h('button', 'ph-composer-send', '发送');
        send.type = 'button';
        send.disabled = true;
        box.appendChild(send);
        return box;
      }

      function paintDerived(root, m) {
        /* 也在详情头里写清「这是谁和谁的交流」（Demo 的 detailHead） */
        var dhead = h('div', 'ph-dhead');
        var who = m.withName || '备忘';
        var dava = h('span', 'ph-row-ava', who.slice(0, 1));
        dava.style.background = ROW_TINTS[phone.hashOf(who) % ROW_TINTS.length];
        dhead.appendChild(dava);
        var dmid = h('div', 'ph-dhead-mid');
        dmid.appendChild(h('p', 'ph-dhead-t', who));
        dmid.appendChild(h('p', 'ph-dhead-s',
          (m.kind === 'draft' ? '没发出去的话' : '他和 ' + who + ' 的幕后交流') +
          (m.lines && m.lines.length ? ' · ' + m.lines.length + ' 条' : '')));
        dhead.appendChild(dmid);
        root.appendChild(dhead);
        var list = h('div', 'ph-bubbles');
        (m.lines || []).forEach(function (ln) {
          var mine = ln.who !== 'other';
          var line = h('div', 'ph-bline' + (mine ? ' is-mine' : ''));
          line.appendChild(h('span', 'ph-bwho', mine ? ch.name : (m.withName || '对方')));
          var bub = h('div', 'ph-bubble');
          bub.appendChild(h('span', null, ln.text || ''));
          line.appendChild(bub);
          list.appendChild(line);
        });
        root.appendChild(list);
        root.appendChild(roComposer());
      }

      /* ----- 第 3 批 · 四个官方 App 本体（全部只读本地表，0 API） ----- */

      /* 备忘录（照 Demo：搜索行 + folders chips + 两列 tone 卡 + 阅读详情） */
      function paintNotes(root) {
        var all = phone.listNotes(ph.id);
        var notes = all;
        /* 照 Demo 的 search：真实过滤（标题/正文） */
        var sBox = h('div', 'ph-search-box');
        sBox.appendChild(h('span', 'ph-search-ic', '⌕'));
        var sIn = h('input', 'ph-search');
        sIn.placeholder = '搜索备忘录';
        sIn.value = noteQuery || '';
        sIn.addEventListener('input', function () { noteQuery = sIn.value; paint(); });
        sBox.appendChild(sIn);
        root.appendChild(sBox);
        if (noteQuery) {
          var nq = noteQuery.toLowerCase();
          notes = notes.filter(function (n) {
            return (n.title || '').toLowerCase().indexOf(nq) >= 0 ||
              (n.content || '').toLowerCase().indexOf(nq) >= 0;
          });
        }
        /* 照 Demo 的 folders：按 folder 字段分组（结算带 folder 才有） */
        var folders = [];
        notes.forEach(function (n) { if (n.folder && folders.indexOf(n.folder) < 0) folders.push(n.folder); });
        if (folders.length) {
          var fr = h('div', 'ph-folders');
          ['全部'].concat(folders).forEach(function (f) {
            var b = h('button', 'ph-folder' + ((noteFolder || '全部') === f ? ' is-on' : ''), f);
            b.type = 'button';
            b.addEventListener('click', function () { noteFolder = f === '全部' ? null : f; paint(); });
            fr.appendChild(b);
          });
          root.appendChild(fr);
          notes = notes.filter(function (n) { return !noteFolder || n.folder === noteFolder; });
        }
        /* 段头 + 计数（Demo 的 section） */
        var section = h('div', 'ph-section');
        section.appendChild(h('b', null, noteFolder || '全部备忘录'));
        section.appendChild(h('span', null, notes.length + ' 篇'));
        root.appendChild(section);

        var list = h('div', 'ph-note-grid');
        root.appendChild(list);
        if (!notes.length) {
          list.appendChild(emptyBlock(
            noteQuery ? '没搜到「' + noteQuery + '」' : '这里暂时没有记录',
            noteQuery ? '换个词试试。' : '他并不会为了填满页面而凭空写东西。'));
          return;
        }
        notes.forEach(function (n, i) {
          var tone = phone.hashOf(n.id || String(i)) % 4;
          var card = h('button', 'ph-note t' + tone);
          card.type = 'button';
          var top = h('div', 'ph-note-top');
          top.appendChild(h('small', null,
            (n.folder ? n.folder + ' · ' : '') + dateStrOf(n.at) + ' ' + timeStr(n.at)));
          card.appendChild(top);
          card.appendChild(h('h3', 'ph-note-t', n.title || '（无标题）'));
          if (n.content) card.appendChild(h('p', 'ph-note-b', n.content));
          var foot = h('div', 'ph-note-foot');
          foot.appendChild(h('span', null, n.folder || '备忘'));
          card.appendChild(foot);
          card.addEventListener('click', function () {
            curView = { kind: 'note', item: n };
            paint();
          });
          list.appendChild(card);
        });
      }
      function paintNoteDetail(root, n) {
        var wrap = h('div', 'ph-read');
        wrap.appendChild(h('p', 'ph-read-meta', dateStrOf(n.at) + ' ' + timeStr(n.at)));
        wrap.appendChild(h('h2', 'ph-read-t', n.title || '（无标题）'));
        wrap.appendChild(h('p', 'ph-read-b', n.content || ''));
        root.appendChild(wrap);
      }

      /* 浏览器：搜索与浏览痕迹（认知过程）。
         Demo 05：渐变 hero（大标题 + 搜索框）→ 胶囊 tabs → 白卡条目
         （方块站点标 + 标题/说明 + 时间 + 起因）→ 收藏是两列封面卡。 */
      function paintBrowser(root) {
        var hero = h('section', 'ph-hero-band');
        hero.appendChild(h('h1', 'ph-hero-band-t', '他最近在查什么'));
        hero.appendChild(h('p', 'ph-hero-band-s', '搜索只说明他想过；收藏才是他准备留下。'));
        var sBox = h('div', 'ph-search-box on-band');
        sBox.appendChild(h('span', 'ph-search-ic', '⌕'));
        var sIn = h('input', 'ph-search');
        sIn.placeholder = '搜索记录';
        sIn.value = browserQuery || '';
        sIn.addEventListener('input', function () { browserQuery = sIn.value; paint(); });
        sBox.appendChild(sIn);
        hero.appendChild(sBox);
        root.appendChild(hero);

        root.appendChild(tabsBar([
          { v: 'search', label: '搜索记录' }, { v: 'bookmark', label: '收藏' }
        ], browserTab, function (v) { browserTab = v; paint(); }));
        var hist = phone.listBrowser(ph.id, browserTab);
        if (browserQuery) {
          var bq = browserQuery.toLowerCase();
          hist = hist.filter(function (x) {
            return String(x.query || '').toLowerCase().indexOf(bq) >= 0 ||
              String(x.note || '').toLowerCase().indexOf(bq) >= 0;
          });
        }
        var list = h('div', browserTab === 'bookmark' ? 'ph-bookmarks' : 'ph-items');
        root.appendChild(list);
        if (!hist.length) {
          list.appendChild(emptyBlock(
            browserQuery ? '没搜到「' + browserQuery + '」'
              : (browserTab === 'bookmark' ? '还没有收藏过的页面' : '他还没在这里搜过什么'),
            browserQuery ? '换个词试试。'
              : (browserTab === 'bookmark' ? '收藏说明他准备留下 —— 有才会出现。'
                : '搜索只说明他想过，没有就是没有。')));
          return;
        }
        hist.forEach(function (x) {
          if (browserTab === 'bookmark') {
            var card = h('div', 'ph-bookmark');
            card.appendChild(h('div', 'ph-bookmark-cover'));
            card.appendChild(h('b', null, x.query));
            if (x.note) card.appendChild(h('p', null, x.note));
            card.appendChild(h('span', 'ph-bookmark-tag', '已收藏'));
            list.appendChild(card);
            return;
          }
          var item = h('div', 'ph-item');
          var top = h('div', 'ph-item-top');
          top.appendChild(h('span', 'ph-site', (x.query || '⌕').slice(0, 1)));
          var mid = h('div', 'ph-item-text');
          mid.appendChild(h('b', null, x.query));
          mid.appendChild(h('small', null, x.note ? '搜索' : '浏览'));
          top.appendChild(mid);
          top.appendChild(h('span', 'ph-item-time', dateStrOf(x.at)));
          item.appendChild(top);
          if (x.note) item.appendChild(h('p', 'ph-item-reason', x.note));
          list.appendChild(item);
        });
      }

      /* 健康打卡（照 Demo 03）：日期切换 → 渐变当日卡 → 方形分段
         （饮食 / 运动 / 随手记）。Demo 的健康评分环不抄 —— 总纲明令禁止。 */
      function paintHealth(root) {
        var days = phone.listHealth(ph.id);
        if (!days.length) {
          var e = h('div', 'ph-cards');
          root.appendChild(e);
          e.appendChild(emptyBlock('还没有打卡记录',
            '他记过才会有 —— 吃没吃、练没练都是日子本身，这里不评分。'));
          return;
        }
        var cur = healthDay || days[0];

        /* 日期 chips（Demo 的 .dates）：上行「今天/昨天/周三」，下行日期。
           只有一天也画 —— Demo 里它一直在这条位置上。 */
        var dates = h('div', 'ph-dates');
        days.forEach(function (d) {
          var label = d.day || dateStrOf(d.at);
          var b = h('button', 'ph-date' + (d === cur ? ' is-on' : ''));
          b.type = 'button';
          b.appendChild(h('b', null, label));
          b.appendChild(h('small', null, dateStrOf(d.at)));
          b.addEventListener('click', function () { healthDay = d; paint(); });
          dates.appendChild(b);
        });
        root.appendChild(dates);

        /* 当日 hero（Demo 的 .hero）：渐变卡 + 标题 + 副行 + 他的备注 */
        var hero = h('section', 'ph-hero-band is-health');
        var top = h('div', 'ph-hero-band-top');
        var tt = h('div', null);
        tt.appendChild(h('h1', 'ph-hero-band-t', (cur.day || dateStrOf(cur.at)) + '的记录'));
        var subs = [];
        if (cur.meals && cur.meals.length) subs.push('记了 ' + cur.meals.length + ' 项进食');
        if (cur.workoutResult) subs.push('动过');
        else if (cur.workoutPlan) subs.push('计划里有运动');
        tt.appendChild(h('p', 'ph-hero-band-s', subs.join(' · ') || '这一天还没有内容'));
        top.appendChild(tt);
        hero.appendChild(top);
        if (cur.comment) hero.appendChild(h('p', 'ph-hero-band-note', cur.comment));
        root.appendChild(hero);

        /* 方形分段控件（Demo 的 .tabs：轨道 + 白底浮起） */
        var seg = h('div', 'ph-seg');
        [{ v: 'diet', label: '饮食' }, { v: 'workout', label: '运动' },
         { v: 'notes', label: '随手记' }].forEach(function (it) {
          var b = h('button', 'ph-seg-tab' + (it.v === healthTab ? ' is-on' : ''), it.label);
          b.type = 'button';
          b.addEventListener('click', function () { healthTab = it.v; paint(); });
          seg.appendChild(b);
        });
        root.appendChild(seg);

        function sectionTitle(t, s) {
          var sec = h('div', 'ph-section');
          sec.appendChild(h('b', null, t));
          sec.appendChild(h('span', null, s));
          return sec;
        }

        /* 运动的「计划 vs 实际」怎么描述 —— 全部由记录本身推导，不评分 */
        function workoutWords(d) {
          if (d.workoutPlan && d.workoutResult && d.workoutPlan !== d.workoutResult) {
            return { sub: '临时改变了计划', chip: '计划有变' };
          }
          if (d.workoutPlan && d.workoutResult) return { sub: '按计划进行', chip: '按计划' };
          if (d.workoutPlan && !d.workoutResult) return { sub: '原计划没有完成', chip: '没去' };
          return { sub: '计划外记的一笔', chip: '额外的' };
        }
        function workoutCard(d) {
          var w = h('article', 'ph-workout');
          var words = workoutWords(d);
          var head = h('div', 'ph-workout-head');
          var icon = h('span', 'ph-workout-ic');
          icon.innerHTML = ic('<path d="M5 9v6M8 7v10M16 7v10M19 9v6M8 12h8"/>');
          head.appendChild(icon);
          var nm = h('span', 'ph-workout-name');
          nm.appendChild(h('b', null, d.workoutName || '运动记录'));
          nm.appendChild(h('small', null, words.sub));
          head.appendChild(nm);
          head.appendChild(h('span', 'ph-status-chip', words.chip));
          w.appendChild(head);
          var cmp = h('div', 'ph-compare');
          cmp.appendChild(planes('原计划', d.workoutPlan || '没安排'));
          cmp.appendChild(planes('实际', d.workoutResult || '没去'));
          w.appendChild(cmp);
          if (d.workoutWhy) w.appendChild(h('p', 'ph-why', d.workoutWhy));
          return w;
        }
        function planes(label, text) {
          var segEl = h('div', 'ph-compare-seg');
          segEl.appendChild(h('small', 'ph-compare-label', label));
          segEl.appendChild(h('b', 'ph-compare-text', text));
          return segEl;
        }

        if (healthTab === 'workout') {
          root.appendChild(sectionTitle('运动计划与实际', '不只记录完成'));
          if (!cur.workoutPlan && !cur.workoutResult) {
            root.appendChild(h('p', 'ph-empty-t', '这一天没有运动记录。'));
          } else {
            root.appendChild(workoutCard(cur));
          }
          return;
        }

        if (healthTab === 'notes') {
          /* 随手记（Demo 的 thoughtPage）：中性汇总两卡 + 他写下的话 */
          var grid = h('div', 'ph-summary');
          var c1 = h('div', 'ph-summary-card');
          c1.appendChild(h('small', null, '饮食记录'));
          c1.appendChild(h('b', null, (cur.meals || []).length + ' 项'));
          c1.appendChild(h('p', null, '包含正餐与额外进食'));
          grid.appendChild(c1);
          var c2 = h('div', 'ph-summary-card');
          c2.appendChild(h('small', null, '运动结果'));
          c2.appendChild(h('b', null, cur.workoutResult ? '动过' : (cur.workoutPlan ? '计划没完成' : '没有安排')));
          c2.appendChild(h('p', null, cur.workoutResult || cur.workoutPlan || '这一天没提运动'));
          grid.appendChild(c2);
          root.appendChild(grid);
          var words2 = (cur.comments && cur.comments.length)
            ? cur.comments
            : (cur.comment ? [cur.comment] : []);
          root.appendChild(sectionTitle('他写下的话', '私人备注'));
          if (!words2.length) {
            root.appendChild(h('p', 'ph-empty-t', '这一天他没留下什么话。'));
            return;
          }
          words2.forEach(function (t, i) {
            var card = h('article', 'ph-thought');
            card.appendChild(h('small', null, '私人记录 ' + (i + 1)));
            card.appendChild(h('p', null, t));
            root.appendChild(card);
          });
          return;
        }

        /* 饮食（默认页） */
        root.appendChild(sectionTitle('这一天的饮食', '按实际记录'));
        (cur.meals || []).forEach(function (m) {
          var card = h('div', 'ph-meal');
          var icEl = h('span', 'ph-meal-ic');
          icEl.innerHTML = ic('<path d="M5 12h14M7 12a5 5 0 0110 0M4 16h16M12 6V4"/>');
          card.appendChild(icEl);
          var mbody = h('div', 'ph-meal-body');
          var mhead = h('div', 'ph-meal-head');
          mhead.appendChild(h('b', null, m.meal || '加餐'));
          if (m.time) mhead.appendChild(h('small', null, m.time));
          mbody.appendChild(mhead);
          mbody.appendChild(h('p', 'ph-meal-text', m.text));
          if (m.comment) mbody.appendChild(h('span', 'ph-meal-comment', m.comment));
          card.appendChild(mbody);
          root.appendChild(card);
        });
        if (!(cur.meals || []).length) {
          root.appendChild(h('p', 'ph-empty-t', '这一天没有记饮食。'));
        }
      }

      /* 淘宝（照 Demo 07）：渐变 hero（标题 + 搜索框）→ 底部导航
         （订单 / 收藏 / 购物车）→ 白卡订单（上图下名/价）+ 两列收藏卡。
         记录购买用途，不默认都是送人的。 */
      function paintShop(root) {
        var hero = h('section', 'ph-hero-band is-shop');
        hero.appendChild(h('h1', 'ph-hero-band-t', '他买过什么'));
        hero.appendChild(h('p', 'ph-hero-band-s', '搜索只证明他想过；下单才是他已经做了的事。'));
        var sBox = h('div', 'ph-search-box on-band');
        sBox.appendChild(h('span', 'ph-search-ic', '⌕'));
        var sIn = h('input', 'ph-search');
        sIn.placeholder = '搜索商品';
        sIn.value = shopQuery || '';
        sIn.addEventListener('input', function () { shopQuery = sIn.value; paint(); });
        sBox.appendChild(sIn);
        hero.appendChild(sBox);
        root.appendChild(hero);

        var sq = (shopQuery || '').trim().toLowerCase();
        function hit(t) { return !sq || String(t || '').toLowerCase().indexOf(sq) >= 0; }

        var list = h('div', 'ph-cards');
        root.appendChild(list);
        if (shopTab === 'favs') {
          var favs = phone.listFavs(ph.id).filter(function (f) { return hit(f.title) || hit(f.note); });
          if (!favs.length) {
            list.appendChild(emptyBlock('收藏夹是空的', '收藏说明他在比较 —— 还没有就是还没有。'));
            return;
          }
          var grid = h('div', 'ph-bookmarks');
          favs.forEach(function (f) {
            var card = h('div', 'ph-bookmark');
            card.appendChild(h('div', 'ph-bookmark-cover'));
            card.appendChild(h('b', null, f.title));
            if (f.note) card.appendChild(h('p', null, f.note));
            card.appendChild(h('span', 'ph-bookmark-tag', '已收藏'));
            grid.appendChild(card);
          });
          list.appendChild(grid);
          return;
        }
        if (shopTab === 'cart') {
          var cart = phone.listCart(ph.id).filter(function (f) { return hit(f.title); });
          if (!cart.length) {
            list.appendChild(emptyBlock('购物车里没有东西', '加购还不是世界承诺，他可以随时换款或放弃。'));
            return;
          }
          var total = 0;
          cart.forEach(function (f) {
            total += Number(f.price) || 0;
            var row = h('div', 'ph-cart-row');
            row.appendChild(h('span', 'ph-cart-check is-on'));
            row.appendChild(h('span', 'ph-thumb', (f.title || '物').slice(0, 1)));
            var info = h('div', 'ph-order-info');
            info.appendChild(h('p', 'ph-card-t', f.title));
            if (f.price) info.appendChild(h('p', 'ph-card-b', '¥' + money(f.price)));
            row.appendChild(info);
            list.appendChild(row);
          });
          if (total) list.appendChild(h('p', 'ph-cart-total', '合计 ¥' + money(total)));
          return;
        }
        var orders = phone.listShop(ph.id).filter(function (o) { return hit(o.title) || hit(o.purpose); });
        if (!orders.length) {
          list.appendChild(emptyBlock('还没有订单', '搜索只证明他想过；真的下单了才会出现在这里。'));
          return;
        }
        orders.forEach(function (o) {
          var card = h('button', 'ph-order');
          card.type = 'button';
          var head = h('div', 'ph-order-head');
          head.appendChild(h('span', 'ph-order-when', dateStrOf(o.at) + ' ' + timeStr(o.at)));
          head.appendChild(h('span', 'ph-order-state', ORDER_STATUS_TXT[o.status] || o.status));
          card.appendChild(head);
          var body = h('div', 'ph-order-body');
          body.appendChild(h('span', 'ph-thumb', (o.title || '物').slice(0, 1)));
          var info = h('div', 'ph-order-text');
          info.appendChild(h('b', null, o.title));
          info.appendChild(h('p', null, o.purpose || '没写用途'));
          if (o.price) info.appendChild(h('small', null, '¥' + money(o.price)));
          body.appendChild(info);
          card.appendChild(body);
          /* clue 行：最近一次状态迁移（真实迁移才画） */
          var hist = o.history || [];
          if (hist.length) {
            var last = hist[hist.length - 1];
            card.appendChild(h('p', 'ph-order-clue',
              dateStrOf(last.at) + ' 从「' + (ORDER_STATUS_TXT[last.from] || last.from) +
              '」变成「' + (ORDER_STATUS_TXT[last.to] || last.to) + '」'));
          }
          card.addEventListener('click', function () {
            curView = { kind: 'order', item: o };
            paint();
          });
          list.appendChild(card);
        });
      }
      function money(v) {
        var n = Number(v) || 0;
        return n % 1 ? n.toFixed(2) : String(n);
      }
      function paintOrderDetail(root, o) {
        var wrap = h('div', 'ph-read');
        /* Demo 的 detailHero：渐变大图带（这里用实物首字，不用占位图） */
        var hero = h('div', 'ph-detail-hero');
        hero.appendChild(h('span', 'ph-detail-hero-c', (o.title || '物').slice(0, 1)));
        wrap.appendChild(hero);
        var info = h('div', 'ph-detail-info');
        info.appendChild(h('h2', null, o.title));
        var meta = [];
        if (o.price) meta.push('¥' + money(o.price));
        if (o.purpose) meta.push('用途：' + o.purpose);
        info.appendChild(h('p', null, meta.join(' · ') || '没有更多信息'));
        wrap.appendChild(info);
        /* 物流时间线（Demo 的 timeline）：只走真实落库的状态迁移 */
        var steps = [{ to: 'ordered', at: o.at }].concat(o.history || []);
        var tl = h('div', 'ph-timeline');
        steps.forEach(function (st, i) {
          var line = h('div', 'ph-tl-line' + (i === steps.length - 1 ? ' is-now' : ''));
          line.appendChild(h('span', 'ph-tl-dot'));
          var mid = h('div', 'ph-tl-mid');
          mid.appendChild(h('b', 'ph-tl-t', ORDER_STATUS_TXT[st.to] || st.to));
          if (st.reason) mid.appendChild(h('p', 'ph-tl-b', st.reason));
          line.appendChild(mid);
          if (st.at) line.appendChild(h('span', 'ph-tl-time', dateStrOf(st.at) + ' ' + timeStr(st.at)));
          tl.appendChild(line);
        });
        wrap.appendChild(tl);
        /* 手机里可见的线索（Demo 的 evidence）：只列真实字段 */
        var ev = h('div', 'ph-evidence');
        ev.appendChild(h('b', null, '手机里可见的线索'));
        var clues = [];
        clues.push('用途写的是「' + (o.purpose || '没写') + '」');
        clues.push('状态迁移 ' + ((o.history || []).length) + ' 次');
        if (o.sourceEventIds && o.sourceEventIds.length) clues.push('来自他自己的日子');
        ev.appendChild(h('span', null, clues.join('；') + '。'));
        wrap.appendChild(ev);
        root.appendChild(wrap);
      }

      function dateStrOf(t) {
        var d = new Date(t);
        return (d.getMonth() + 1) + '月' + d.getDate() + '日';
      }

      /* 工坊自定义 App：他自己记下的内容（records，展示即 confirmed） */
      function paintCustomApp(root, inst) {
        var recs = Sleepy.workshop.recordsOf(inst.id);
        var list = h('div', 'ph-cards');
        root.appendChild(list);
        if (!recs.length) {
          list.appendChild(h('p', 'ph-empty-t', '「' + inst.templateName + '」刚装上，他还没记过东西。'));
          return;
        }
        recs.forEach(function (r) {
          var f = r.fields || {};
          var card = h('div', 'ph-card');
          card.appendChild(h('p', 'ph-card-t', f.title || f.name || f.thing || f.item ||
            f.when || f.date || inst.templateName));
          var body = f.content || f.text || f.why || f.detail || f.what || f.note || '';
          if (body) card.appendChild(h('p', 'ph-card-b', body));
          if (r.sourceType === 'model_derived' && r.runId) card.appendChild(h('p', 'ph-card-note', '来自他自己的日子'));
          card.appendChild(h('p', 'ph-card-time', dateStrOf(r.at) + ' ' + timeStr(r.at)));
          list.appendChild(card);
        });
      }

      /* ----- 被抓现场 ----- */
      function paintCaught() {
        var wall = ph.wallpaper % phone.WALLS.length;
        var root = h('div', 'ph-root ph-caught ph-wall-' + wall);
        var whereText = {
          lock: '手机还停在密码界面。',
          messages: '你正停在「消息」里。',
          taobao: '你正停在「淘宝」里。',
          notes: '你正停在「备忘录」里。',
          browser: '你正停在「浏览器」里。',
          health: '你正停在「健康打卡」里。',
          desktop: '他回来的时候，手机就在你手里。'
        }[caughtInfo.where] || '他回来的时候，手机就在你手里。';

        root.appendChild(h('div', 'ph-caught-card'));
        root.lastChild.appendChild(h('p', 'ph-caught-k', '被发现了'));
        root.lastChild.appendChild(h('p', 'ph-caught-t', whereText));
        /* 他这一刻怎么反应，交给 char 自己演（2026-09-21 拍板：
           「被发现我觉得要交给 char 决定要怎么做」）。本地不写死惩罚。 */
        var react = h('p', 'ph-caught-react', '他正站在你身后……');
        root.lastChild.appendChild(react);
        root.lastChild.appendChild(h('p', 'ph-caught-s',
          '手机怎么处置，也由他决定。'));
        root.appendChild(actionBtn('放回手机', 'putback', putBack));
        body.appendChild(root);
        loadCaughtReaction(react);
      }

      /* 拉 char 的即时反应（page-phone-ai 的 caughtReaction）。
         没配 API / 生成失败都老实说 —— 不编一句假台词糊弄（六.1 的教训）。 */
      function loadCaughtReaction(el) {
        if (!Sleepy.phoneAI || !Sleepy.phoneAI.caughtReaction) {
          el.textContent = '他的反应，等你回到聊天里就知道了。';
          return;
        }
        Sleepy.phoneAI.caughtReaction(sb.id, ownerId, caughtInfo)
          .then(function (r) {
            if (r && r.ok && r.text) {
              el.textContent = r.text;
            } else if (r && r.error === 'noapi') {
              el.textContent = '（还没配 API —— 他的反应，等你回到聊天里就知道了。）';
            } else {
              el.textContent = '（这次没能生成他的反应' +
                (r && r.error ? '：' + r.error : '') +
                ' —— 等你回到聊天里，他会让你知道的。）';
            }
          });
      }

      /* ---------- 小工具 ---------- */

      /* 照 Demo 的 tabs/tab：一排页签，选中即重绘 */
      function tabsBar(items, cur, onPick) {
        var bar = h('div', 'ph-tabs');
        items.forEach(function (it) {
          var b = h('button', 'ph-tab' + (it.v === cur ? ' is-on' : ''), it.label);
          b.type = 'button';
          b.addEventListener('click', function () { onPick(it.v); });
          bar.appendChild(b);
        });
        return bar;
      }

      function actionBtn(label, kind, onClick) {
        var b = h('button', 'ph-btn ph-btn-' + (kind || 'ghost'), label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
      }

      function chatNameOf(chat) {
        var c = Sleepy.chatStore && Sleepy.chatStore.findCharacter(chat.characterId);
        return (c && c.name) || chat.name || '角色';
      }
      function userNameOf(chat) {
        var u = core.findUser(chat.userId);
        /* user 侧名字留空 → 回落微信名（唯一出口 core.labelOfUser） */
        return core.labelOfUser(u);
      }
      function lastRealMsg() {
        var chats = (Sleepy.chatStore ? Sleepy.chatStore.getChats() : [])
          .filter(function (c) { return core.rootIdOf(c.characterId) === ownerId; })
          .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        if (!chats.length) return null;
        var c = chats[0];
        var ms = c.messages || [];
        return { chat: c, msg: ms[ms.length - 1] };
      }
      function previewMsg(m) {
        if (!m) return ' ';
        if (m.recalledAt) return '撤回了一条消息';
        if (m.type === 'photo') return '[照片]';
        if (m.type === 'sticker') return '[表情' + (m.name ? '·' + m.name : '') + ']';
        if (m.type === 'transfer') return '[转账 ¥' + (Number(m.amount) || 0).toFixed(2) + ']';
        if (m.type === 'pat') return '[拍了拍]';
        if (m.type === 'file') return '[文件]';
        return String(m.content || '').replace(/\s+/g, ' ').slice(0, 24);
      }
      function previewGroup(last) {
        return last ? previewMsg(last) : ' ';
      }
      function bubbleText(m) {
        if (m.recalledAt) return '撤回了一条消息';
        return previewMsg(m) === ' ' ? '' : previewMsg(m);
      }

      /* 开场（定案 §二 分流）：
         stage='putback' → 入口页点了「放回原处」，直接给收束画面；
         stage='peek'    → 入口页已经演过「捡到」这一幕了，直接做分流；
         长期授权      → 按授权范围直接进，不经过捡到/锁屏；
         其余（群岛选人）→ 先停在「捡到」这一幕，由 user 选 偷看一下 / 放回原处。 */
      var stage = ctx.params && ctx.params.stage;
      if (stage === 'putback') {
        endingInfo = { k: '放回去了', t: '你把手机放回去了。',
          s: '屏幕暗下去，像是什么也没有发生。' };
        mode = 'ending';
        paint();
        return;
      }
      if (stage === 'peek') { tryEnter(); return; }
      if (phone.longPermFor(ph.id, 'all')) {
        ph.lastExitedAt = null;
        phone.savePhone(ph);
        beginSession('longterm', 'longterm');
      } else {
        mode = 'found';
        paint();
      }
    }

  /* ============================ App 工坊 ============================
     工坊的页面与数据层都在 page-workshop.js（index.html 里排在最后一个，
     同名 registry 由它注册）。这里原先留过一个「模板施工中」的门面，
     第 4 批接入后已删 —— 死代码留着只会让人以为工坊还没做。 */

})(window);
