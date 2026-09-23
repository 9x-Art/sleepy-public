/* ============================================================
   page-desktop.js — 桌面（模块 H：4 屏网格 + 系统级切号）
   依赖：store.js、core.js、ui.js、app.js
   页面：home（就是它，注册在首页那个 section 上）

   ---- 设计要点（《终极架构总纲》第 1 节）----
   · 彻底摒弃「固定栏位」：整个桌面是**多屏可滑动的自由网格**。
     没有任何 App 被焊死在特定位置 —— 连「设置」「世界书」也只是一格组件。
   · 所有入口皆为组件，位置来自 store 的 desktop.pages（数据化，C2 要求），
     不在代码里写死。这样以后加拖拽只要改数据，不用动渲染。
   · 自由加组件：除了 App 图标，还能加情绪印章、照片墙等大尺寸组件。
   · 原位替换：切号时格子里的**数据**和**视觉皮肤**跟着当前角色瞬间切换。
     户型（x/y/w/h）走「**全局一份 + 按岛覆盖**」（2026-09-21 拍板：岛覆盖 > 全局）：
     user 没动过桌面的岛大家共用同一张（升级 LAYOUT_VERSION 全员一起变）；
     user 在哪座岛摆过，就给那座岛记一份完整布局（desktop.islands[sbId]），
     读写都按活动岛路由（getDesktop 叠 / setDesktop 写），
     但 **App 集合永远完整** —— 改的是摆哪/长什么样，不是装了什么。

   ---- 4 屏的分工 ----
     第 0 屏（负一屏）照片墙 —— 角色愿意给你看的那些画面
     第 1 屏  主屏 —— 角色卡 + 常用 App + 情绪印章 + 电量
     第 2 屏  时区/音乐 —— 异地恋的两块钟
     第 3 屏  音乐卡 + 待办

   ---- 为什么不是 <button class="icon"> 那一套 ----
   老版主屏是 3 列固定图标 + 底部 dock，位置写死在 index.html 里。
   那正是总纲里点名要废弃的「固定栏位」。这里改成 4 列 bento 网格，
   每格有自己的 grid-area，由数据决定。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;

  var h = ui.h;

  var PAGES = 4;
  var COLS = 4;
  var ROWS = 6;

  /* 统一的线性图标：24 格、currentColor、线宽 1.6。
     和聊天页顶栏 / 加号面板同一套 —— 项目里不许混入 emoji，
     各系统渲染得都不一样，摆一排像拼的。 */
  var SVG = 'viewBox="0 0 24 24" width="24" height="24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  function ic(body, size) {
    var s = size ? 'viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"' : SVG;
    return '<svg ' + s + '>' + body + '</svg>';
  }

  var ICONS = {
    chat: ic('<path d="M4.5 6.8A2.3 2.3 0 0 1 6.8 4.5h10.4a2.3 2.3 0 0 1 2.3 2.3v7.4a2.3 2.3 0 0 1-2.3 2.3H10l-4.2 3.2a.55.55 0 0 1-.88-.44z"/><path d="M8.5 9.3h7M8.5 12.3h4.5"/>'),
    moments: ic('<rect x="3.5" y="7.5" width="12" height="10" rx="1.5"/><path d="M8 7.5V6A1.5 1.5 0 0 1 9.5 4.5h9A1.5 1.5 0 0 1 20 6v8a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M6.5 14.5l2.5-2.5 2 2 1.5-1.5 2 2"/>'),
    diary: ic('<rect x="5" y="4" width="14.5" height="16" rx="2"/><path d="M9 4v16"/><path d="M12.5 8.5H16M12.5 12h3.5"/>'),
    /* 「记忆」不再是独立 App —— 它是名片夹里挂在根节点上的一个面板。
       图标留着，给以后要做的「记忆总览」用。 */
    memory: ic('<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="9.5" r="1.4"/><path d="M6.5 16l3.5-3.5 2.5 2.5 2-2 3 3"/>'),
    favorites: ic('<path d="M12 4.6l2.3 4.7 5.2.75-3.75 3.66.89 5.19L12 16.45 7.36 18.9l.89-5.19L4.5 10.05l5.2-.75z"/>'),
    me: ic('<circle cx="12" cy="8.4" r="3.5"/><path d="M5.5 19.2c0-3.1 2.9-5.3 6.5-5.3s6.5 2.2 6.5 5.3"/>'),
    idcard: ic('<rect x="4" y="5.5" width="16" height="13" rx="2"/><circle cx="9" cy="10.5" r="1.8"/><path d="M13.5 9h3.5M13.5 12h3.5M7 15.5h10"/>'),
    worldbook: ic('<path d="M12 6.6C10.6 5.2 8.6 4.6 5.5 4.6v13.2c3.1 0 5.1.6 6.5 2 1.4-1.4 3.4-2 6.5-2V4.6c-3.1 0-5.1.6-6.5 2z"/><path d="M12 6.6v13.2"/>'),
    settings: ic('<circle cx="12" cy="12" r="3.1"/><path d="M12 3.4v2.3M12 18.3v2.3M20.6 12h-2.3M5.7 12H3.4"/><path d="M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6M18.1 18.1l-1.6-1.6M7.5 7.5L5.9 5.9"/>'),
    heartbeat: ic('<path d="M3.6 12h3.2l2-4.4 2.8 9 2.4-6 1.6 3.2h4.8"/>'),
    gallery: ic('<rect x="3.5" y="5" width="17" height="14" rx="2.4"/><circle cx="9" cy="10" r="1.5"/><path d="M4.6 16.6l4.4-3.9 3.4 3 3-2.5 4 3.4"/>'),
    todo: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 14.5l1.6 1.6L14 12.6"/>', 14),
    /* 外观：调色盘。组件商城：购物袋 */
    appearance: ic('<path d=\"M12 3.6a8.4 8.4 0 0 0 0 16.8c1.15 0 1.6-.86 1.15-1.62-.5-.9.15-1.98 1.35-1.98h1.7A4.32 4.32 0 0 0 20.4 12 8.4 8.4 0 0 0 12 3.6z\"/>' +
      '<circle cx=\"9.1\" cy=\"10.4\" r=\"1.05\"/><circle cx=\"12\" cy=\"8.6\" r=\"1.05\"/><circle cx=\"14.9\" cy=\"10.4\" r=\"1.05\"/>'),
    widgetstore: ic('<path d=\"M5.2 8.6h13.6l-1 9.9a1.7 1.7 0 0 1-1.7 1.5H7.9a1.7 1.7 0 0 1-1.7-1.5z\"/>' +
      '<path d=\"M9.2 8.6V6.9a2.8 2.8 0 0 1 5.6 0v1.7\"/>'),
    /* 第 3 屏的占位 App 用：贴纸、钱包。风格跟上面那批线稿图标一致 */
    stickers: ic('<circle cx="12" cy="12" r="8.4"/>' +
      '<path d="M12 7.6l1.42 2.88 3.18.46-2.3 2.24.54 3.16L12 14.85l-2.84 1.49.54-3.16-2.3-2.24 3.18-.46z"/>'),
    wallet: ic('<rect x="3.6" y="6.4" width="16.8" height="11.6" rx="2.4"/>' +
      '<path d="M16.4 10.6h4v3.2h-4a1.6 1.6 0 0 1 0-3.2z"/>'),
    /* 预设：叠着的两张卡（预设注入系统的配置 app，第 2 屏） */
    presets: ic('<rect x="4.5" y="3.5" width="12" height="15" rx="1.8"/>' +
      '<path d="M8.5 7.5h4M8.5 10.5h4"/>' +
      '<path d="M19.5 7.2v11.3a1.8 1.8 0 0 1-1.8 1.8H8.9"/>'),
    /* 查手机：手机 + 小放大镜（第 2 屏，角色翻看这部手机里的东西） */
    phonecheck: ic('<rect x="7" y="3" width="10" height="18" rx="2"/>' +
      '<path d="M10.5 18.3h3"/>' +
      '<circle cx="11" cy="10.6" r="2.1"/><path d="M13.6 13.6l1.8 1.8"/>'),
    /* 工坊：扳手（第 2 屏，做小东西的地方） */
    workshop: ic('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    /* 日历（第 3 屏，2026-09-19 接到该格）：一本翻开的台历 + 顶上两个挂环 */
    calendar: ic('<rect x="3.6" y="5.4" width="16.8" height="14.2" rx="2.2"/>' +
      '<path d="M3.6 10.2h16.8"/>' +
      '<path d="M8.6 3.4v3.6M15.4 3.4v3.6"/>' +
      '<path d="M7.4 13.4h2.2M12.4 13.4h4.2M7.4 16.4h2.2M12.4 16.4h2.4"/>'),
    clock: ic('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3 1.8"/>', 32),    mood: ic('<circle cx="12" cy="12" r="8.6"/><path d="M8.8 14.2a4.2 4.2 0 0 0 6.4 0"/><path d="M9.2 9.6h.01M14.8 9.6h.01"/>', 32)
  };

  /* ---------------------------- 默认布局 ---------------------------- */

  /* 「户型」是 base（全局一份），切号时不动 ——
     user 在哪座岛自定义过，就给那座岛记一份覆盖（desktop.islands[sbId]，
     读写见 getDesktop/setDesktop）。
     每一格：{ i:id, app:页面id | null, type:组件类型, x,y,w,h, label }
     坐标是 1-based 的 CSS Grid 线（第 2 行起），跟 grid-area 直接对应。

     ---- 布局约定（改这里之前先看一眼）----
     · 同一屏里的格子**不允许重叠**。CSS Grid 会静默地让后插入的元素盖在
       先插入的上面，不报错、不缺图，只是「有一个东西不见了」，很难查。
       所以新增组件前先数一遍空格，别只看前几行有没有空。
     · 底部 dock 是**全局**常用入口（聊天 / 世界书 / 设置），
       不放「名片夹」「朋友圈」这类聊天 App 内部的构造。
       每屏都必须有可自由移动的网格，App 一律进网格，不叠在别的组件上。 */
  /* 布局版本。**每次改动 defaultDesktop 的户型都要 +1**，
     否则改了代码、用户的浏览器里还是旧布局 ——
     因为 getDesktop() 会把老存档直接拿来用。

     这个坑踩过一次：第 2 屏的 App 挪了位置，代码和冒烟断言全绿，
     但截图里那俩图标还是压在时钟上。根因是存档里的旧户型没被替换，
     代码改了个寂寞。

     版本 9/10/11（2026-09-18）：第 3 屏重排 —— 日历换成音乐卡（新组件类型
     `music`），待办去掉外框（直接落在页面上、点击就地编辑）。
     一晚跳了三版，全是同一屏在微调格子。**每一跳都是必要的**：
     9 → 10 是待办收到 2×2、右半边补占位 App；
     10 → 11 是把占位里的「日记」换成「设置」（日记被冒烟断言挡下来了）。
     不跳号的话，用户浏览器里存的还是旧户型 —— 实测过一次，
     代码明明改了、截图里那格还是旧的。

     版本 8：第 2 屏再收一格 —— 「正在播放」撤掉。

     版本 7：第 2 屏重排 —— 双城时间整个撤掉，整屏让给
     「亚克力挂件灯」（新组件类型 `lamp`，4 列 × 4 行），
     下面第 5 行四个 App。

     版本 6（2026-09-17 第四轮）：主屏整体重排。上半屏换成一块
     「日期头」（类型 hdr，占 1~3 行整宽），下面只剩两行：
       第 4 行  世界书 / 组件商城 / 浮岛 / 外观
       第 5 行  聊天 / 设置 / 夜间模式开关（横跨 2 格）
     同时从主屏上撤掉：角色卡、情绪印章、时间、思念电量、相册、
     收藏夹、「我的」。
     角色卡和情绪印章是用户点名拿掉的；时间和思念电量也是；
     相册 / 收藏夹 / 我的 是因为用户明确说主屏「保留这六个 App」，
     剩下的位置不再摆它们（相册和「我的」在第 2 屏还有）。
     第 6 行与以下留空 —— 等用户看完这一版再决定放什么。

     版本 5：桌面上的「日记」「朋友圈」两个 App 拿掉（它们都并进聊天 App 了），
     格位换成「外观」和「组件商城」。

    版本 12（2026-09-18 晚）：第 2 屏第 5 行「设置」格换成「预设」。
    见第 2 屏那段注释。

    版本 14（2026-09-19）：第 2 屏第 5 行换两个 App ——
    「世界书」主屏已有，这份换成「查手机」；「我的」没设计想法，
    换成「工坊」。两个页面本体都还没开工（占位页），等用户发需求。

    版本 15（2026-09-19 深夜）：第 3 屏第 4 行第 4 列的「设置」格
    换成「日历」（用户拍板：日历是**单独的桌面 App**，不是查手机里那个；
    同一轮里查手机侧的日历 App 已经撤掉）。选它是因为设置本来就是
    桌面上重复度最高的一个 —— 主屏与第 2 屏各有一份（同版本 12 那条理由）。
    格子 id 仍沿用 p3-settings 不变 —— 那只是格子的名字。

     版本 4：名片夹 → 浮岛（`app: 'contacts'` 改成 `app: 'island'`，
     标签跟着改）。占位 id 故意沿用 `p1-idcard` 不变 —— 它只是这个格子的
     名字，改了会让老存档里的位置对不上，白白丢掉用户摆过的坐标。 */
  /* 版本 16（2026-09-19）：主屏第 6 行补上「帷境」通栏入口。
     帷境是**独立的一整个世界**（深夜蓝 / 月光纸本，见 style.css 里
     `[data-page^="wj-"]` 那一段），所以它不走 app 图标格 ——
     用新的 'wj' 渲染器做一条通栏：两片幕布 + 一行衬线字。 */
  var LAYOUT_VERSION = 16;

  function defaultDesktop() {
    return {
      version: LAYOUT_VERSION,
      pages: [
        /* 第 0 屏（负一屏）：拍立得照片墙
           2026-09-18 第十二版：整屏重做成「电影胶片拼贴」——
           左上场记板、右上胶片盘、中间一墙拍立得、底下一截「下一镜头」纸带。
           参考图是深蓝底 + 撕纸边，用户选的是**只搬结构、配色还是我们的**，
           所以底子仍是纯白 + 焦糖。组件本身也不带玻璃底（一整块贴在墙上）。 */
        [
          { i: 'p0-wall', type: 'wall', x: 1, y: 1, w: 4, h: 6, label: '照片墙' }
        ],
        /* 第 1 屏：主屏 —— 日期头（含拉手）+ 六个 App + 夜间模式开关 */
        [
          { i: 'p1-head', type: 'hdr', x: 1, y: 1, w: 4, h: 3, label: '日期' },
          { i: 'p1-book', type: 'app', app: 'worldbook', x: 1, y: 4, w: 1, h: 1, label: '世界书' },
          { i: 'p1-store', type: 'app', app: 'widgetstore', x: 2, y: 4, w: 1, h: 1, label: '组件商城' },
          /* id 沿用 p1-idcard 不变 —— 见上面版本 4 那条注释 */
          { i: 'p1-idcard', type: 'app', app: 'island', x: 3, y: 4, w: 1, h: 1, label: '浮岛' },
          { i: 'p1-look', type: 'app', app: 'appearance', x: 4, y: 4, w: 1, h: 1, label: '外观' },
          { i: 'p1-chat', type: 'app', app: 'chat-list', x: 1, y: 5, w: 1, h: 1, label: '聊天' },
          { i: 'p1-settings', type: 'app', app: 'settings', x: 2, y: 5, w: 1, h: 1, label: '设置' },
          { i: 'p1-mode', type: 'mode', x: 3, y: 5, w: 2, h: 1, label: '夜间模式' },
          /* 版本 16：第 6 行一直是空的，补上「帷境」通栏入口。
             它不是普通 App 图标格 —— 帷境是整套产品里唯一
             「进 App 就换一个世界」的地方，值得一条通栏的仪式感。
             type 是新的 'wj'，渲染器在下面 RENDER.wj。 */
          { i: 'p1-weijing', type: 'wj', x: 1, y: 6, w: 4, h: 1, label: '帷境' }
        ],
        /* 第 2 屏：挂件灯 + 四个 App
           2026-09-18 第七版：**双城时间整个撤掉**（用户：「这个双城时间
           可以直接删掉」），整屏让给那盏灯。

           第八版：**「正在播放」也撤掉**（用户：「宝宝这个可以去掉」）——
           它本来就是个占位组件，一个图标加一行字，并不真播东西。

           灯给到 4 列 × 4 行（374×374）—— 用户看到 2×3 那格之后的原话是
           「替换正在播放我会担心有点小，完全看不出字」。而且它放大态的暗场
           **只铺满自己的容器**，容器小，点开之后那张卡也大不了。

           第十二版（2026-09-18 晚）：第 5 行第一个格子「设置」换成
           「预设」（prompt-engine 的配置 app）—— 设置在主屏和第 3 屏
           各有一份，重复度最高，动它最不亏（用户：「随便替换一个就可以」）。
           格子 id 沿用 p2-settings 不变 —— 老存档的坐标别丢。

           ⚠️ 第 5 行下面那片空白是**翻屏唯一的手感区**：灯在桌面态也吃手势了
           （用户要求，见 style.css 里 .w-lamp-host canvas 那段），
           所以第 5 行那四个 App 和底下的空白是手指唯一能划走的地方，
           别把它们排满。 */
        [
          { i: 'p2-lamp', type: 'lamp', x: 1, y: 1, w: 4, h: 4, label: '挂件灯' },
          { i: 'p2-settings', type: 'app', app: 'presets', x: 1, y: 5, w: 1, h: 1, label: '预设' },
          /* 版本 14：这两个格子换 App 了（用户 2026-09-19）——
             「世界书」主屏已经有一个，第 2 屏这份换成「查手机」；
             「我的」暂时没有设计想法，换成「工坊」。
             页面本体还没开工，点开是占位页，等用户发下一段需求再填。
             ⚠️ 格子 id 沿用 p2-me / p2-book 不变 —— 那只是格子的名字，
             改了老存档里的坐标就对不上了（同版本 4 那条规矩）。 */
          { i: 'p2-me', type: 'app', app: 'workshop', x: 2, y: 5, w: 1, h: 1, label: '工坊' },
          { i: 'p2-book', type: 'app', app: 'phonecheck', x: 3, y: 5, w: 1, h: 1, label: '查手机' },
          { i: 'p2-memory', type: 'app', app: 'memory', x: 4, y: 5, w: 1, h: 1, label: '留痕' }
        ],
        /* 第 3 屏：音乐卡 + 待办
           2026-09-18 第九版：**日历整块撤掉**，换成音乐卡（用户：「这个
           直接被刚刚那个替换掉」）。待办从通栏挪到**中间右边**，
           并且不再是玻璃卡 —— 直接落在页面上（用户：「不要圆角框框，
           换成直接在页面上面的」）。

           音乐卡给 4 列 × 2 行（374×179）—— 参考图那张横版播放卡大约是
           2:1，这个格子正好 2.09:1，是最贴的形状。
           第九版当晚又调了一次：待办收到 **(1,3) 2×2**（用户：「todo 只占
           第三四行左边两列」），右半边和第五行补上一排**占位 App** ——
           用户原话「其他适当加占位app」。第六行故意留空，
           手机上那一行加上底栏，整个屏底才有透气的地方。 */
        [
          { i: 'p3-music', type: 'music', x: 1, y: 1, w: 4, h: 2, label: '音乐' },
          { i: 'p3-todo', type: 'todo', x: 1, y: 3, w: 2, h: 2, label: '待办' },
          /* 下面这些是**占位 App**（用户：「其他适当加占位app」）。
             优先挑**整个桌面都还没摆过**的：收藏夹原本在主屏被撤掉过，正好补回来；
             贴纸和钱包也一直没上过桌面（这两件是本轮新画的线稿图标）。
             ⚠️ 别顺手放「日记」—— 它和朋友圈都在 chat 里，冒烟里有一条断言守着，
             放回去会直接红。 */
          { i: 'p3-fav', type: 'app', app: 'favorites', x: 3, y: 3, w: 1, h: 1, label: '收藏夹' },
          { i: 'p3-stickers', type: 'app', app: 'stickers', x: 4, y: 3, w: 1, h: 1, label: '贴纸' },
          { i: 'p3-wallet', type: 'app', app: 'wallet', x: 3, y: 4, w: 1, h: 1, label: '钱包' },
          /* 这里原本放的是「日记」，被冒烟断言挡下来了：
             「日记 / 朋友圈那两个我们都在 chat 里面做了，不需要单独的 app」——
             那是很早定下的一条，不能因为要凑格子就把它放回来。
             版本 15 换成**日历**（原来的「设置」挪走 —— 它在主屏和第 2 屏
             各有一份，是这里重复度最高的一个）。 */
          { i: 'p3-settings', type: 'app', app: 'calendar', x: 4, y: 4, w: 1, h: 1, label: '日历' },
          { i: 'p3-book', type: 'app', app: 'worldbook', x: 1, y: 5, w: 1, h: 1, label: '世界书' },
          { i: 'p3-gallery', type: 'app', app: 'gallery', x: 2, y: 5, w: 1, h: 1, label: '相册' },
          { i: 'p3-look', type: 'app', app: 'appearance', x: 3, y: 5, w: 1, h: 1, label: '外观' },
          { i: 'p3-store', type: 'app', app: 'widgetstore', x: 4, y: 5, w: 1, h: 1, label: '组件商城' }
        ]
      ]
    };
  }

  function getDesktop() {
    var d = store.get('desktop');

    /* 没有存档 / 结构不对：落一份默认的 */
    if (!d || !Array.isArray(d.pages) || d.pages.length !== PAGES) {
      d = defaultDesktop();
      store.set('desktop', d);
      return withIslandOverlay(d);
    }

    /* 有存档但户型版本旧：迁移。
       策略是「保住户型里的自定义、补上前一版没有的新东西」——
       直接覆盖会把用户自己摆过的位置抹掉，所以只做增量：
       同 id 的格子保留用户在存档里的坐标和新版里新增/缺失的格子补齐。 */
    if ((d.version || 1) < LAYOUT_VERSION) {
      d = migrateDesktop(d, LAYOUT_VERSION);
      store.set('desktop', d);
    }
    return withIslandOverlay(d);
  }

  /* ---- 户型的岛覆盖层（2026-09-21 拍板：岛覆盖 > 全局）----
     user 在哪座岛上摆过桌面，就给那座岛记一份**完整布局**
     （desktop.islands[sbId]，跟外观穿着的 islands 同一套心智）；
     没动过的岛继续共用全局那份 —— LAYOUT_VERSION 升级时全员一起变。
     读：getDesktop() 按活动岛叠；写：**只能走 setDesktop()**，它负责
     把改动落到对的层（岛覆盖 / 全局底座），别直接 store.set('desktop')。 */
  function activeIslandId() {
    try {
      var sb = core.activeSandbox();
      return sb ? sb.id : '';
    } catch (e) { return ''; }
  }

  function withIslandOverlay(base) {
    var sbId = activeIslandId();
    if (!sbId || !base) return base;
    var ov = base.islands && base.islands[sbId];
    if (!ov || !Array.isArray(ov.pages) || ov.pages.length !== PAGES) return base;
    /* 覆盖层也跟着户型版本走：旧了就地迁移，别让某座岛卡在老布局上 */
    if ((ov.version || 1) < LAYOUT_VERSION) {
      ov = migrateDesktop(ov, LAYOUT_VERSION);
      base.islands[sbId] = ov;
      store.set('desktop', base);
    }
    return ov;
  }

  function setDesktop(d) {
    var sbId = activeIslandId();
    if (!sbId) { store.set('desktop', d); return; }
    var base = store.get('desktop');
    if (!base || !Array.isArray(base.pages) || base.pages.length !== PAGES) {
      base = defaultDesktop();
    }
    base.islands = base.islands || {};
    var ov = base.islands[sbId];
    if (!ov || !Array.isArray(ov.pages) || ov.pages.length !== PAGES) {
      /* 这座岛第一次自定义：当前生效的布局（多半是全局那份 + 这次的改动）
         整份复制下来当岛的底 —— 全局那份保持不动，别的岛不受牵连。 */
      base.islands[sbId] = JSON.parse(JSON.stringify(d));
    } else {
      base.islands[sbId] = d;
    }
    store.set('desktop', base);
  }

  /* 把老存档迁到当前户型版本。

     策略：以**新版默认户型**为骨架（因为它才是经过核对、无重叠的那一份），
     逐格尝试沿用老存档里同 id 的坐标 —— 这样用户自己摆过的位置不会丢。
     一旦沿用导致重叠，就把**这一格**退回新版坐标（而不是整屏放弃）。

     为什么不直接覆盖成新版：那会把用户摆过的位置抹掉。
     为什么不整屏保留老版：用户可能正卡在一个坏户型里
     （比如上一版那个 App 压在时钟上的 bug），得让他能出来。 */
  function migrateDesktop(old, toVersion) {
    var fresh = defaultDesktop();
    var oldById = {};
    (old.pages || []).forEach(function (cells) {
      (cells || []).forEach(function (c) { if (c && c.i) oldById[c.i] = c; });
    });

    fresh.pages.forEach(function (cells, pi) {
      var defaults = defaultDesktop().pages[pi];
      var defById = {};
      defaults.forEach(function (c) { defById[c.i] = c; });

      /* 第一步：先尽量沿用老坐标 */
      cells.forEach(function (c) {
        var prev = oldById[c.i];
        if (!prev) return;
        c.x = prev.x; c.y = prev.y;
        c.w = prev.w; c.h = prev.h;
      });

      /* 第二步：从后往前扫，谁跟别人撞了谁退回新版坐标。
         从后往前是为了让「先摆的」优先保住位置。 */
      for (var a = cells.length - 1; a >= 0; a--) {
        for (var b = 0; b < cells.length; b++) {
          if (a === b) continue;
          if (!overlap(cells[a], cells[b])) continue;
          var def = defById[cells[a].i];
          if (def) { cells[a].x = def.x; cells[a].y = def.y; cells[a].w = def.w; cells[a].h = def.h; }
          break;
        }
      }
    });

    fresh.version = toVersion;
    return fresh;
  }

  function overlap(A, B) {
    return A.x < B.x + B.w && B.x < A.x + A.w &&
           A.y < B.y + B.h && B.y < A.y + A.h;
  }

  /* ---------------------------- 角色皮肤 ---------------------------- */

  /* 「原位替换机制」：桌面的户型通用，但每一格里的数据和皮肤
     跟着当前角色走。这里读的是当前切号选中的大号。 */
  var MOODS = ['有点累', '还不错', '在想你', '有点烦', '很平静', '想见你'];

  /* 日期头用的中文月名 / 星期名。
     不用 Intl.DateTimeFormat('zh-CN')：部分老 WebView 上拿不到中文月名，
     会对着一堆数据兜底成 "M09"，反而更难查。十二个词查表最稳。 */
  var MONTHS_CN = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  var WEEKDAYS_CN = ['星期天', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  /* ---------------- 夜间模式开关的「话筒形」轮廓 ----------------
     用户第五轮给的参考图（3D 渲染那张）的轮廓**不是一个圆角矩形**：
     左边一个**整圆**，右边接一根**长条**，两块并成一个整体，
     中间嵌一颗开关 —— 用户原话「有点像麦克风一样」。

     路径只在这里出现**一次**，两个地方都用它生成：
       · SVG 那条描边（.w-mode-edge）—— 负责「亮边」
       · 玻璃那层的 mask（.w-mode-shape）—— 负责「能透出壁纸」
     两份各写一遍的话，改形状时漏改一处，轮廓和亮边就会错开、露出一条缝。

     坐标系 220×100，和格子的长宽比（约 2.2）对得上：
       圆：(50,50) r=48               → x 2..98
       条：x 84..214，y 16..84，右端 r=34
     两个交点在 (83.9,16) 和 (83.9,84) —— 由 (x−50)²+34² = 48² 解出来。 */
  var MODE_VIEWBOX = '0 0 220 100';
  var MODE_PATH =
    'M50,2A48,48,0,0,1,83.9,16L180,16A34,34,0,0,1,180,84' +
    'L83.9,84A48,48,0,0,1,50,98A48,48,0,0,1,50,2Z';
  /* mask 用 data-URI 给玻璃那层。用 encodeURIComponent 拼而不是手写百分号转义 ——
     手写的话路径里一个逗号或空格漏转义，整块玻璃就直接不显示了，很难查。 */
  var MODE_MASK = 'url("data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + MODE_VIEWBOX + '">' +
    '<path d="' + MODE_PATH + '"/></svg>') + '")';

  /* 阿基米德螺线 —— 音乐卡封面那圈纹路用它画。
     参数化而不是写死一串坐标：以后想调半径、圈数，改两个数就行。 */
  function spiralPath(cx, cy, turns, r0, r1, steps, phase) {
    var d = '';
    var p0 = phase || 0;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var a = p0 + t * turns * Math.PI * 2;
      var r = r0 + (r1 - r0) * t;
      d += (i ? 'L' : 'M') + (cx + Math.cos(a) * r).toFixed(1) + ',' +
        (cy + Math.sin(a) * r).toFixed(1);
    }
    return d;
  }

  /* 音乐卡封面那几道螺旋臂。
     上一版是两根同色的同心螺线，读出来就是「一圈一圈的灰圈」——
     用户要的是「螺旋式的颜色好看点的」。所以改成**四臂**，相位各差 90°，
     颜色从陶土 → 奶黄 → 藕粉 → 焦糖走一遍暖色渐变，
     再叠几颗白点当星子。四臂从圆心往外拧，才有星系那种转起来的感觉。 */
  var MUSIC_ARMS = [
    { c: 'rgba(203,116,86,.80)', w: 1.9, turns: 3.6, r0: 4.5, phase: 0 },
    { c: 'rgba(242,197,112,.82)', w: 1.7, turns: 3.6, r0: 5.5, phase: Math.PI / 2 },
    { c: 'rgba(223,146,146,.62)', w: 1.4, turns: 3.4, r0: 4.8, phase: Math.PI },
    { c: 'rgba(178,140,102,.42)', w: 1.2, turns: 3.2, r0: 6.2, phase: Math.PI * 1.5 }
  ];
  var MUSIC_STARS = [
    [22, 20, 1.5], [78, 26, 1.2], [30, 76, 1.3], [70, 74, 1.1],
    [50, 14, 1.0], [16, 52, 0.9], [85, 55, 1.0], [58, 88, 0.9]
  ];
  function musicCover() {
    var out = '<span class="w-music-sheen"></span>' +
      '<svg viewBox="0 0 100 100" aria-hidden="true">';
    MUSIC_ARMS.forEach(function (a) {
      out += '<path class="w-music-arm" d="' +
        spiralPath(50, 50, a.turns, a.r0, 44, 260, a.phase) +
        '" style="stroke:' + a.c + ';stroke-width:' + a.w + '"/>';
    });
    MUSIC_STARS.forEach(function (t) {
      out += '<circle class="w-music-star" cx="' + t[0] + '" cy="' + t[1] +
        '" r="' + t[2] + '"/>';
    });
    out += '<circle class="w-music-hub" cx="50" cy="50" r="5.4"/>' +
      '<circle class="w-music-hub-dot" cx="50" cy="50" r="1.7"/>' +
      '</svg>';
    return out;
  }

  /* ---------------- 亚克力挂件灯（第 2 屏的主件） ----------------
     引擎与核心都在 vendor/ 里，靠 index.html 那张 importmap 把裸名 "three"
     指到本地文件。这里**不写 <script type="module">** —— 那样开机就要下载
     797 KB，而这盏灯在第 2 屏，很多人一轮都不一定滑过去。改成动态 import()：
     第一次真要显形时才拉。动态 import() 在经典脚本里是允许的。

     ⚠️ 模块版**必须走 http(s)**：浏览器禁止从 file:// 加载 ES module，
     双击打开时这里会 reject，我们兜一句提示，不影响页面其它部分。

     ---- 三个必须处理的坑（都是实测出来的）----
     ① **重画会把 canvas 连根拔掉**。`ctx.repaint()` 会 `grid.innerHTML=''`，
       而桌面的 `onShow` 每次都调 repaint —— 也就是「从任意 App 回桌面」
       都会重建一次。而这盏灯的创建**是阻塞的**（核心源码注释里写：不预热的话
       用户第一次点卡片主线程会冻 2.1 秒，所以作者把那次编译挪到了创建时）。
       所以它绝不能跟着重建：节点被摘下来时只摘不销毁，下次渲染再挂回去。
     ② **容器没尺寸时核心会回落到整个窗口**（`host.clientWidth || innerWidth`）——
       实测把容器塌成 0×0 反而让画布从 179×276 变成 828×1792，更贵。
       所以节点没挂在文档上时**不要创建**，等下次渲染再建。
     ③ **`dispose()` 不调 `forceContextLoss()`**（实测 loseContext 一次都没触发）。
       补上，否则反复重建会把浏览器的 WebGL 上下文配额耗光。 */

  var LAMP_FILE = './vendor/acrylic-lamp-core.js';

  /* 卡片内容：内置那 11 个图案（猫/星星/云朵/皇冠…）先全部去掉 ——
     用户原话「现在的这些画其实会看起来很廉价」，以后由角色往里写。
     配色也全部换成冷/中性色：内置调色板 `PALETTE` 里 11 个色**全是高饱和粉彩**
     （#FF9EC2 / #FFD451 这种），卡片会读成实心塑料板；换成 ink/sky/aqua
     之后才读得出磨砂玻璃。这条是实测出来的最省钱的一次改善。
     ⚠️ 传几张都没用：36 个挂点是核心的 CFG.rings 写死的（`defs[n % defs.length]`），
     这里只是让它们循环使用这 4 种空板。 */
  var LAMP_CARDS = [
    { text: '', art: 'text', tone: 'ink' },
    { text: '', art: 'text', tone: 'sky' },
    { text: '', art: 'text', tone: 'aqua' },
    { text: '', art: 'text', tone: 'ink' }
  ];

  /* 灯光。用户要的是「user 自己切」，这里先只落**默认值和存档**，
     切换入口之后挂到外观或组件商城（API 现成：lamp.setLight(name)）。
     默认 day 是实测结论 —— 内置四档在浅色底上：
       day    浅奶油磨砂，最贴白色 UI        ← 选它
       warm   琥珀金，偏重但成立
       candle 橙得过头
       moon   卡片发脏橄榄褐，最差（它本来就是为深底做的） */
  var LAMP_DEFAULT_LIGHT = 'day';

  var lampState = {
    create: null,     // 动态 import 回来的 createAcrylicLamp
    loading: null,    // 正在加载的 promise
    inst: null,       // 当前实例
    host: null,       // 实例挂着的容器节点（重画保活要认它）
    box: null,        // 当前那个 .w-lamp 节点
    light: null,      // 已经生效的灯光档，用来判断要不要重设
    home: null        // 它平时待在哪个格子里（放大时要挪走，回来再放回去）
  };

  /* 放大态要浮到**所有层**上面，但光给 z-index 是不够的：
     `.dt-grid` 自己带 `position:relative; z-index:1`，是个层叠上下文 ——
     里面的 z-index 再高也出不去；而底栏 `.dt-dock` 挂在 `.page` 那一层、
     z-index 6，照样把灯压住（实测：放大后底栏原样浮在暗场上面）。
     所以放大时把节点**挪到 .page 这一层**，和底栏做同级比较，40 就压得过 6；
     失焦再放回原来的格子。 */
  function applyLampFocus() {
    var box = lampState.box;
    if (!box || !box.isConnected) return;
    var on = !!(lampState.inst && lampState.inst.focused);
    box.classList.toggle('is-focus', on);

    var page = box.closest ? box.closest('.page') : null;
    if (on) {
      if (page && box.parentNode !== page) {
        lampState.home = box.parentNode;
        page.appendChild(box);
      }
    } else if (lampState.home && box.parentNode !== lampState.home) {
      lampState.home.appendChild(box);
    }
  }

  function lampLight() {
    var v = store.get('lampLight');
    return v || LAMP_DEFAULT_LIGHT;
  }

  function loadLampCore() {
    if (lampState.create) return Promise.resolve(lampState.create);
    if (lampState.loading) return lampState.loading;
    lampState.loading = import(LAMP_FILE).then(function (m) {
      lampState.create = m.default || m;
      return lampState.create;
    });
    /* 失败时把 loading 清掉，下次进第 2 屏可以再试一次（比如中途恢复了网络） */
    lampState.loading['catch'](function () { lampState.loading = null; });
    return lampState.loading;
  }

  /* 真正销毁。只有「整页要走了」才调 —— 平时重画只摘不销（见上面坑①）。 */
  function killLamp() {
    var el = lampState.inst;
    if (!el) return;
    lampState.inst = null;
    try {
      el.dispose();
      /* 核心的 dispose() 只管 three 那一侧，不还 WebGL 上下文。补上。 */
      if (el.renderer && el.renderer.forceContextLoss) el.renderer.forceContextLoss();
    } catch (e) { /* 销毁失败也不该带塌整页 */ }
  }

  window.addEventListener('pagehide', killLamp);

  /* 时段问候。用 [起, 止, 文案] 的表，比一串 if 好读也好改。 */
  var GREETS = [
    [5, 11, '早上好'],
    [11, 13, '中午好'],
    [13, 18, '下午好'],
    [18, 23, '晚上好']
  ];
  function greetOf(h) {
    for (var i = 0; i < GREETS.length; i++) {
      if (h >= GREETS[i][0] && h < GREETS[i][1]) return GREETS[i][2];
    }
    return '夜深了';
  }

  function skin() {
    /* 指针卫兵：当前 char 必须在本岛名册里。群岛落岛有意不替人选，
       全局指针还停在上一个岛的人身上时，这里宁可显示「还没有角色」，
       也不能把别的岛的人摆上来（清查 §5.1）。 */
    var c = core.activeCharOnIsland ? core.activeCharOnIsland() : core.activeChar();
    /* 「我」也过岛卫兵：指针停在上一座岛时，双城时钟宁可写「这里」，
       也不摆上一个别座岛的人的城市。 */
    var u = core.activeUserOnIsland ? core.activeUserOnIsland() : core.activeUser();
    var mood = '';
    if (c) {
      /* 情绪印章优先用角色自己记的，没有就按名字稳定取一个 ——
         用日期做种子的随机会在刷新时跳来跳去，看着像 bug。 */
      mood = c.mood || MOODS[hashOf(c.id) % MOODS.length];
      if (c.mood && c.moodAt && Date.now() - c.moodAt > 86400000) mood = MOODS[hashOf(c.id) % MOODS.length];
    }
    /* 空态文案要分清「岛上没人」和「岛上有人但还没选」——
       后者提示去选人，别让人误以为房是空的。 */
    var roster = 0;
    try {
      var sbNow = core.activeSandbox();
      if (sbNow) roster = (core.charsOfSandbox(sbNow) || []).length;
    } catch (e) { /* 忽略 */ }
    return {
      char: c,
      user: u,
      name: c ? c.name : (roster ? '还没选人' : '还没有角色'),
      status: (c && c.status) ||
        (c ? '在线' : (roster ? '从桌面下拉或切号器选一位' : '去浮岛开一间房')),
      mood: mood,
      battery: c && typeof c.battery === 'number' ? c.battery : 40
    };
  }

  function hashOf(s) {
    var t = String(s || '');
    var n = 0;
    for (var i = 0; i < t.length; i++) n = (n * 31 + t.charCodeAt(i)) >>> 0;
    return n;
  }

  function saveActive(patch) {
    /* 写路径同样过卫兵 —— 换心情写进上一个岛的角色是清查 §5.1 的真违规 */
    var c = core.activeCharOnIsland ? core.activeCharOnIsland() : core.activeChar();
    if (!c) return false;
    var list = core.allChars();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== c.id) continue;
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) list[i][k] = patch[k];
      }
      return core.saveChars(list);
    }
    return false;
  }

  /* ---------------------------- 组件渲染 ---------------------------- */

  /* 把一个格子渲染成 DOM 节点。render 和 repaint 共用这一份 ——
     早先两处各写了一遍（render 里一段、repaint 里一段），
     加个 .w-1x1 之类的细节很容易只改一边。 */
  function renderCell(cell, ctx) {
    var node = null;
    var fn = RENDER[cell.type];
    if (fn) {
      /* 单个组件炸了不该带塌整屏 —— 兜一个空壳，其余格子照常出来。
         静默吞异常是刻意的：桌面上有一个「坏格子」远好过整页白屏。 */
      try { node = fn(cell, ctx); } catch (e) { node = null; }
    }
    if (!node) {
      node = h('div', 'widget w-app w-dead');
      node.appendChild(h('span', 'w-app-name', cell.label || '组件出错'));
    }
    node.style.gridArea = cell.y + ' / ' + cell.x + ' / ' +
      (cell.y + cell.h) + ' / ' + (cell.x + cell.w);
    if (cell.w === 1 && cell.h === 1) node.classList.add('w-1x1');

    /* 编辑态里每个组件都挂一个小叉叉 = 把它从桌面拿掉。
       用户：「桌面进入编辑模式后，所有的组件都加上一个小叉叉，
       就是把这个组件删掉的意思」—— 这是以后**组件商城**的地基：
       桌面从此是「一个可增删的组件集合」，不再是一张写死的图。 */
    node.appendChild(killBtn(cell, ctx));
    return node;
  }

  /* 「拿掉」那个小叉叉。放在组件内部的左上角 ——
     不能挂在角外面（.widget 是 overflow:hidden，挂出去会被裁掉，
     看着就像按钮没渲染出来）。 */
  function killBtn(cell, ctx) {
    var b = h('button', 'dt-kill');
    b.type = 'button';
    b.title = '把「' + (cell.label || '这个组件') + '」拿掉';
    b.setAttribute('aria-label', '拿掉这个组件');
    b.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

    /* 三个事件都要拦住：
       pointerdown 不拦 → 编辑态里会立刻起拖，叉叉跟着组件飞；
       click 由 bindCell 在**捕获阶段**吞掉（它要防止长按抬手误开 App），
       所以那边也专门放行了 .dt-kill。 */
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('touchstart', function (e) { e.stopPropagation(); });
    b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      ui.confirm({
        title: '把「' + (cell.label || '这个组件') + '」从桌面拿掉？',
        note: '组件商城做好之后可以再装回来',
        ok: '拿掉',
        danger: true
      }).then(function (yes) {
        if (!yes) return;
        removeCell(ctx, cell);
      });
    });
    return b;
  }

  /* 删掉的组件记一笔 —— 组件商城的「你删过的」用它装回来。
     x/y/pi 必须带上：不带的话装回来只能「找第一块空位」，
     用户精心摆的位置就回不去了（清查报告 §8.1）。
     记录盖当前房的章（tagScope）：删岛时按章清掉，不留幽灵岛的回收站。 */
  function rememberRemoved(cell, pi) {
    var list = store.get('desktopRemoved') || [];
    var rec = {
      type: cell.type, app: cell.app || '', label: cell.label || '',
      w: cell.w, h: cell.h,
      x: cell.x, y: cell.y, pi: typeof pi === 'number' ? pi : null,
      at: Date.now()
    };
    if (core.tagScope) core.tagScope(rec);
    list.push(rec);
    store.set('desktopRemoved', list.slice(-60));
  }

  function removeCell(ctx, cell) {
    var d = getDesktop();
    for (var pi = 0; pi < d.pages.length; pi++) {
      var list = d.pages[pi] || [];
      var at = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].i === cell.i) { at = i; break; }
      }
      if (at < 0) continue;

      list.splice(at, 1);
      /* 整体写回 —— 走 setDesktop（岛覆盖 > 全局，写错层 = 改了别的岛）
         store.get 给的是副本，改完要 set 一次 */
      setDesktop(d);
      rememberRemoved(cell, pi);

      if (ctx.repaint) ctx.repaint();
      /* 删完还留在编辑态 —— 不然想连着删第二个得重新长按一次 */
      enterEdit(ctx, true);
      ctx.toast('拿掉了', 'ok');
      return true;
    }
    return false;
  }

  /* 每个 type 一个渲染器。加新组件只要往这里加一项 +
     在 defaultDesktop 里放一格，不需要动别的地方。 */
  var RENDER = {

    app: function (cell, ctx) {
      var box = h('button', 'widget w-app');
      box.type = 'button';
      /* 桌面外观系统：单 App 的名称/图标覆盖（外观 App 里改）优先于默认 */
      var ov = (Sleepy.appearance && Sleepy.appearance.appOverride)
        ? Sleepy.appearance.appOverride(cell.app) : null;
      var icEl = h('span', 'w-app-ic');
      if (ov && ov.iconMediaId && Sleepy.media) {
        var oimg = h('img', 'w-app-ic-img');
        Sleepy.media.url(ov.iconMediaId).then(function (u) { if (u) oimg.src = u; });
        icEl.appendChild(oimg);
      } else {
        icEl.innerHTML = ICONS[cell.app] || ICONS.chat;
      }
      box.appendChild(icEl);
      box.appendChild(h('span', 'w-app-name', (ov && ov.name) || cell.label || ''));
      box.addEventListener('click', function () { ctx.open(cell.app); });
      return box;
    },

    /* ---------------- 帷境入口（主屏第六行那条通栏） ----------------
       2026-09-21：改成跟其他 App 图标同一套玻璃（透明、跟主题）——
       以前写死深蓝 + 两片幕布，用户觉得在白桌面上太突兀、换配色也不跟着变。
       样式在 style.css 的 .w-wj 那一段。 */
    wj: function (cell, ctx) {
      var box = h('button', 'widget w-wj');
      box.type = 'button';
      var copy = h('span', 'w-wj-copy');
      copy.appendChild(h('b', 'w-wj-name', '帷境'));
      copy.appendChild(h('span', 'w-wj-line', '今晚，想读哪一种可能？'));
      box.appendChild(copy);
      box.addEventListener('click', function () { ctx.open('wj-foyer'); });
      return box;
    },

    char: function (cell, ctx) {
      var box = h('div', 'widget w-char');
      var s = skin();

      if (s.char && (s.char.avatar || s.char.avatarMedia)) {
        var img = h('img', 'w-char-av');
        core.setAvatarImg(img, s.char);
        img.alt = s.name;
        box.appendChild(img);
      } else {
        box.appendChild(h('span', 'w-char-av w-char-initial', core.initialOf(s.name)));
      }
      box.appendChild(h('div', 'w-char-name', s.name));
      box.appendChild(h('div', 'w-char-status', s.status));

      /* 点头像＝系统级切号（时空切换器）。
         总纲说它是「系统级的一个切换菜单/入口」，不限定为特定图标 ——
         所以这里让它挂在角色卡上，同时另一条路是长按桌面空白处。 */
      box.addEventListener('click', function () { openSwitcher(ctx); });
      box.title = '切换角色';
      return box;
    },

    mood: function (cell, ctx) {
      var box = h('div', 'widget w-mood');
      var s = skin();
      box.appendChild(h('div', 'w-label', 'MOOD'));
      var icEl = h('div', 'w-mood-ic');
      icEl.innerHTML = ICONS.mood;
      box.appendChild(icEl);
      box.appendChild(h('div', 'w-mood-text', s.mood));
      box.addEventListener('click', function () { cycleMood(ctx); });
      box.title = '点一下换心情';
      return box;
    },

    /* ---------------- 首页日期头（主屏最上面那块） ----------------
       2026-09-17 第四轮。用户给的参考版式：一行小字抬头、一个很大的
       日期数字、一行日期，右侧一根绳子挂下来一个小玻璃坠子。

       第五轮改动（用户：「我要字体直接呈现在上面，而不是加框」）：
       **整块不再有玻璃面板** —— 没有底、没有边框、没有投影，
       字直接压在壁纸上（同 .w-app 的做法，见 style.css 里 .w-hdr 那段）。
       加框的时候字是被「装」起来的；去掉框之后才是排版本身在撑场面，
       所以字号和间距都放大了一档。

       用户还提了「换成全部中文之后太空了」。中文比英文短
       （主屏·01 vs HOME·01，九月·星期四 vs SEPTEMBER · WEDNESDAY），
       同样的版式会一下子瘦一圈。补了三样把版面撑回来：
         · 大数字放大到字号主导整个屏
         · 日期下面加一条细横线（参考图底部本来就有这条）
         · 再加一行时段问候（早上好 / 夜深了），把下半段的空白压住
         文案是照着参考图的骨架重写的（用户：「这个只是一个示例，
       可以改成更好的」）：
         HOME · 01            → 主 屏 · 01
         16                   → 今天几号
         SEPTEMBER · WEDNESDAY→ 九月 · 星期四
         PULL TO CHOOSE       → 拉 开 选 人
       数字用当天真实日期，不是写死的。

       坠子**这一轮仍然只做外观**（用户选的）：点了给一句提示，
       不做拖拽。以后接上「拉开 → 桌面倾斜 → 露出手风琴式角色卡」。 */
    hdr: function (cell, ctx) {
      var box = h('div', 'widget w-hdr');
      var now = new Date();

      var inner = h('div', 'w-hdr-inner');
      var kicker = h('div', 'w-hdr-kicker');
      kicker.appendChild(h('span', null, '主 屏'));
      kicker.appendChild(h('i', 'w-hdr-sep', '·'));
      kicker.appendChild(h('span', null, '01'));
      inner.appendChild(kicker);

      var day = h('div', 'w-hdr-day', String(now.getDate()));
      inner.appendChild(day);
      var dateEl = h('div', 'w-hdr-date',
        MONTHS_CN[now.getMonth()] + ' · ' + WEEKDAYS_CN[now.getDay()]);
      inner.appendChild(dateEl);
      inner.appendChild(h('div', 'w-hdr-rule'));
      var greet = h('div', 'w-hdr-greet', greetOf(now.getHours()));
      inner.appendChild(greet);
      box.appendChild(inner);

      /* 跨零点要翻日期，跨时段要换问候。挂一个一分钟的轻量计时，
         不重画整屏 —— 只改这两个节点的文字。 */
      var lastKey = '';
      function stamp(d) {
        return d.getDate() + '|' + d.getMonth() + '|' + d.getDay() + '|' + Math.floor(d.getHours() / 1);
      }
      lastKey = stamp(now);
      var timer = setInterval(function () {
        var d = new Date();
        var key = stamp(d);
        if (key === lastKey) return;
        lastKey = key;
        day.textContent = String(d.getDate());
        dateEl.textContent = MONTHS_CN[d.getMonth()] + ' · ' + WEEKDAYS_CN[d.getDay()];
        greet.textContent = greetOf(d.getHours());
      }, 60000);
      box.__cleanup = function () { clearInterval(timer); };

      /* ---- 右上角的坠子 ----
         标签用**英文**：用户第五轮的反馈是「拉开选人那个改成原本的英文好一些」
         （原本参考图写的 PULL TO CHOOSE）。竖排时拉丁字母会跟着转 90°，
         正好是参考图里那个样子；中文竖排是正立的，气质不一样。 */
      var pull = h('button', 'w-hdr-pull');
      pull.type = 'button';
      pull.title = '拉开换个角色';
      pull.setAttribute('aria-label', '拉开选择角色');
      pull.appendChild(h('span', 'w-hdr-cord'));
      pull.appendChild(h('span', 'w-hdr-knob'));
      pull.appendChild(h('span', 'w-hdr-pull-label', 'PULL TO CHOOSE'));
      /* 点一下、或者按住往下拽超过 24px，都算「拉开」。
         触屏上「拉」比「点」顺手，但纯点也要保住 —— 鼠标用户就靠它。
         拽完松手浏览器还会补一个 click，openCharPull 里有防重入。 */
      pull.addEventListener('click', function () { openCharPull(ctx); });
      (function () {
        var sy = null;
        pull.addEventListener('pointerdown', function (e) { sy = e.clientY; });
        pull.addEventListener('pointerup', function (e) {
          if (sy === null) return;
          var dy = e.clientY - sy;
          sy = null;
          if (dy > 24) openCharPull(ctx);
        });
        pull.addEventListener('pointercancel', function () { sy = null; });
      })();
      box.appendChild(pull);

      /* ---- 装饰：一枚细描边的「环」 ----
         用户第五轮：「目前这个还是有点空了……可以加一点别的装饰」。
         空的位置其实是**字右边那一大片**（中文比英文短，四行字只占左边一格宽，
         右边 60% 全空着）。环放在那儿正好压住。
         选环是有意的：它和坠子那颗玻璃胶囊、还有 App 里的「浮岛」是同一个意象，
         比随便撒几个点更有出处。三层：外环 / 内环 / 环上一点。 ——
         全部只有描边、不用实色，压在壁纸上也只是一点淡淡的痕迹。 */
      var orn = h('span', 'w-hdr-orn');
      orn.setAttribute('aria-hidden', 'true');
      orn.appendChild(h('span', 'w-hdr-orn-ring'));
      orn.appendChild(h('span', 'w-hdr-orn-ring w-hdr-orn-ring-2'));
      orn.appendChild(h('span', 'w-hdr-orn-dot'));
      box.appendChild(orn);

      return box;
    },

    /* ---------------- 夜间模式开关 ----------------
       轮廓见上面 MODE_PATH 那段注释（左圆 + 右长条 = 话筒形）。

       为什么是「玻璃层 + 描边层」两层，而不是一层加个 border：
       **border 跟不上非矩形的轮廓** —— 圆角矩形写作 border 没问题，
       但这条轮廓是圆和长条的并集，border 只会沿着元素自己的方框走，
       圆的左半边会露出来、长条的上下边完全没有边。
       `filter: drop-shadow` 也不行：描边是白的、玻璃本身才 .16~.40 的通明度，
       影子跟着源图 alpha 走，糊出来是一圈若有若无的灰，不是一条边。
       所以：玻璃那层用 mask 裁出形状（能透出壁纸），
       描边交给一层 SVG 的 `<path stroke>` 盖在上面 —— 它沿着真实轮廓走，
       而且是盖在玻璃**上面**的，不会跑去当玻璃的背景
       （放下面的话，白色描边会整个变成玻璃的 backdrop，壁纸就透不上来了）。

       **它是真能用的**：直接切 Sleepy.appearance 的 theme。
       （外观 App 是这套主题的唯一出口，这里只是多开一个入口；
       两边都走 appearance.set，所以不会出现「开关和外观页不同步」。） */
    mode: function (cell, ctx) {
      var box = h('button', 'widget w-mode');
      box.type = 'button';

      /* 玻璃本体：mask 裁成话筒形，backdrop-filter 把壁纸透上来。
         暖色影子**不走独立元素** —— 试过了，独立元素的模糊一定会
         往外洇成一坨黄渍，而且和玻璃里那层暖色叠起来会出现块状斑。
         现在暖色只画在玻璃自己的 background 里，被 mask 精确裁住。 */
      var shape = h('span', 'w-mode-shape');
      shape.style.webkitMaskImage = MODE_MASK;
      shape.style.maskImage = MODE_MASK;
      box.appendChild(shape);

      /* 这里本来还有一层 SVG 描边当「亮边」。用户第六轮否掉了：
         「只需要里面那层就好了，最外面的线框不要」——
         一圈独立的白线飘在形状外面，读起来像设计稿的线框而不是控件。
         现在轮廓只由玻璃自己的填充定义（见 style.css 的 .w-mode-shape）。
         注意：MODE_PATH 仍然要用，玻璃那层的 mask 就是它 —— 别顺手删。 */

      var sw = h('span', 'w-mode-sw');
      sw.appendChild(h('span', 'w-mode-knob'));
      box.appendChild(sw);
      box.appendChild(h('span', 'w-mode-label', cell.label || '夜间模式'));

      function isNight() {
        var a = Sleepy.appearance;
        return !!(a && a.get().theme === 'night');
      }
      function sync() {
        var on = isNight();
        box.classList.toggle('is-on', on);
        box.setAttribute('aria-pressed', on ? 'true' : 'false');
      }

      box.addEventListener('click', function () {
        var a = Sleepy.appearance;
        if (!a) { ctx.toast('外观模块还没加载出来'); return; }
        var on = isNight();
        /* 关掉时回「纯白」。不记「上次那个浅色主题」是因为外观页
           本来就是切主题的地方，多存一份状态只会多一处对不上的可能。 */
        a.set({ theme: on ? 'grape' : 'night' });
        sync();
        ctx.toast(on ? '回到白天' : '开夜灯', 'ok');
      });

      sync();
      return box;
    },

    /* ---------------- 亚克力挂件灯 ----------------
       生命周期见上面 lampState 那段注释。这里只管「把节点摆好」：
         · lampState.host 已经存在 → 直接搬过来复用（**重画保活**的关键）
         · 不存在 → 先摆一个「点亮中…」，等模块到位再创建

       放大态要浮到所有层之上（用户要求）。做法是给 box 挂 .is-focus，
       由 CSS 把它变成 position:fixed; inset:0; z-index 压过 dock ——
       `.page` 上有 transform，所以 fixed 的包含块是**整个手机屏**而不是
       浏览器窗口，范围正好。 */
    lamp: function (cell, ctx) {
      /* 上一帧的 box 若还在放大态（被挪到 .page），重画前先收掉 ——
         重画只清 grid，挪出去的旧节点没人管，会一直压在屏上
         （用户 2026-09-21：切过外观后模型变大、显示不全）。 */
      var prev = lampState.box;
      if (prev && prev.parentNode && prev.parentNode.classList &&
          prev.parentNode.classList.contains('page')) {
        prev.parentNode.removeChild(prev);
      }

      var box = h('div', 'widget w-lamp');

      var host = lampState.host;
      if (!host) {
        host = h('div', 'w-lamp-host');
        lampState.host = host;
      }
      box.appendChild(host);

      var note = h('div', 'w-lamp-note', '点亮中…');
      box.appendChild(note);
      lampState.box = box;
      lampState.home = null;   // 每次重画都换新节点，旧的位置作废

      function publish(el) {
        lampState.inst = el;
        box.classList.add('is-ready');
        note.style.display = 'none';
        /* 灯光：实例是**常驻**的，重画时只是换个格子挂着，不会重建 ——
           所以每次都要重读一遍存档，不然在别处（以后的外观/组件 App）
           把灯切了，回到桌面看还是旧的那档。 */
        var want = lampLight();
        if (lampState.light !== want) {
          lampState.light = want;
          el.setLight(want);
        }
        /* 核心留了两个回调槽，正好用来跟着放大态翻 class + 挪节点 */
        el.onFocus = applyLampFocus;
        el.onBlur = applyLampFocus;
        applyLampFocus();
      }

      if (lampState.inst) {
        publish(lampState.inst);
        /* 换屏/换格子后容器尺寸变了，让核心重新取景。
           但要等 box 真的挂进 DOM 再量 —— renderCell 返回后调用方才 append，
           这时 host.clientWidth 还是 0，直接 resize 会让核心回落到 window
           尺寸，canvas 被撑成整窗、看着「变大又下移」
           （用户 2026-09-21：切过外观后 3D 模型变大、显示不全）。 */
        var inst = lampState.inst;
        requestAnimationFrame(function () {
          if (lampState.inst !== inst) return;
          var hostEl = lampState.host;
          if (hostEl && hostEl.clientWidth > 0) inst.resize();
        });
        return box;
      }

      /* ---- 懒加载的**真正触发点** ----
         坑：桌面在启动时就把 4 屏全建出来了（横向滚动需要），所以
         「第 2 屏那一格被渲染」**不等于**「用户会看到它」——
         如果在 renderCell 里直接开加载，开机照样要下 797 KB，
         懒加载等于白做（实测：停在第 1 屏时 three.module.js 已经在
         resource timing 里了）。
         所以用 IntersectionObserver 盯着这一格：它快进视野了才开始拉。
         rootMargin 左右各放一屏，从第 1 屏往右滑的时候就已经在下，
         滑到位基本就绪。
         用默认 root（视口）就够 —— 祖先 .dt-scroll 的 overflow 裁剪
         会被算进去，没滑到就是不相交。 */
      var boot = function () {
        if (lampState.inst) { publish(lampState.inst); return; }
        loadLampCore().then(function (create) {
          if (lampState.inst) { publish(lampState.inst); return; }
          /* 坑②：节点没挂在文档上时容器尺寸是 0，核心会回落到整个窗口。
             这时候宁可先不建，等下一次渲染（每次 onShow 都会 repaint）。 */
          if (!box.isConnected || !host.isConnected) return;
          publish(create(host, {
            cards: LAMP_CARDS,
            frame: 'champagne',
            autoSpin: 0.06,
            dust: true,
            /* 手机屏 dpr 动辄 3，画 3 倍像素肉眼看不出、卡顿却很实在。
               核心自己也封到 2，这里再往下压一档。 */
            dpr: window.devicePixelRatio > 1.5 ? 1.5 : 1
          }));
          /* 灯光在 publish 里统一应用，这里不重复设 */
        })['catch'](function () {
          note.textContent = '这盏灯要点亮需要走 http（本地服务器或线上）';
          note.classList.add('is-bad');
        });
      };

      if (!window.IntersectionObserver) { boot(); return box; }

      /* ⚠️ root 必须显式给 .dt-scroll，**不能用默认的视口**。
         用视口的时候 rootMargin 只放大「视口」，而这一格被祖先 .dt-scroll
         的横向裁剪挡着 —— 裁剪范围不跟着 rootMargin 放大，所以停在第 1 屏时
         它依旧算「不相交」，一屏都提前不了（实测：滑到第 2 屏才开始下）。
         给成 .dt-scroll 之后，rootMargin 才作用在真正的那条滚动轴上：
         左右各放 520px（比一屏 414 宽一点），从第 1 屏就开始下，
         滑到位往往已经点着了。 */
      /* ⚠️ 观察者要**等节点入文档之后再挂**。
         renderCell 是在 appendChild **之前**调的，这时候 box 还没爹，
         `box.closest('.dt-scroll')` 直接返回 null —— 于是静悄悄退回
         「root: 视口」，而视口那套是被祖先裁剪卡死的，预加载等于没开
         （实测：停在第 1 屏时一个字节都没下）。
         所以推迟一拍。cleanup 要**同步**挂好，不然这一拍里来一次重画，
         观察者就漏了一个。 */
      var io = null, stopped = false;
      box.__cleanup = function () { stopped = true; if (io) io.disconnect(); };
      setTimeout(function () {
        if (stopped || !box.isConnected) return;
        io = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (!entries[i].isIntersecting) continue;
            io.disconnect();
            boot();
            return;
          }
        }, {
          root: box.closest('.dt-scroll'),
          rootMargin: '0px 520px 0px 520px',
          threshold: 0
        });
        io.observe(host);
      }, 0);

      return box;
    },

    clock: function (cell, ctx) {
      var box = h('div', 'widget w-clock');
      var t = h('div', 'w-clock-time', '--:--');
      var d = h('div', 'w-clock-date');
      var d1 = h('span', '', '');
      var d2 = h('span', '', '');
      d.appendChild(d1);
      d.appendChild(d2);
      box.appendChild(t);
      box.appendChild(d);
      function tick() {
        var now = new Date();
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        t.textContent = p(now.getHours()) + ':' + p(now.getMinutes());
        d1.textContent = p(now.getDate()) + ' / ' + p(now.getMonth() + 1) + '月';
        d2.textContent = '星期' + '日一二三四五六'.charAt(now.getDay());
      }
      tick();
      var timer = setInterval(tick, 15000);
      box.__cleanup = function () { clearInterval(timer); };
      return box;
    },

    battery: function (cell, ctx) {
      var box = h('div', 'widget w-battery');
      var head = h('div', 'w-bat-head');
      head.appendChild(h('span', '', '思念电量'));
      var hint = h('span', 'w-bat-hint', '摸摸头');
      head.appendChild(hint);
      var track = h('div', 'w-bat-track');
      var fill = h('div', 'w-bat-fill');
      track.appendChild(fill);

      var level = skin().battery;
      function paint() {
        fill.style.width = level + '%';
        hint.textContent = level >= 100 ? '已满！' : '摸摸头';
      }
      paint();

      box.appendChild(head);
      box.appendChild(track);
      box.addEventListener('click', function () {
        level = Math.min(level + 20, 100);
        paint();
        saveActive({ battery: level });
        if (level >= 100) ctx.toast('电量满了', 'ok');
      });
      return box;
    },

    worldclock: function (cell, ctx) {
      var box = h('div', 'widget w-worldclock');
      var s = skin();
      var mine = h('div', 'w-wc-block');
      var his = h('div', 'w-wc-block');
      function clock(label, offset) {
        var wrap = h('div', 'w-wc-inner');
        var t = h('div', 'w-wc-time', '--:--');
        wrap.appendChild(t);
        wrap.appendChild(h('div', 'w-wc-city', label));
        return { el: wrap, t: t, offset: offset };
      }
      var c1 = clock('你（' + (s.user ? s.user.city || '这里' : '这里') + '）', 0);
      var c2 = clock((s.char ? s.name : '对方') + '（' + ((s.char && s.char.city) || '那边') + '）', 7);
      mine.appendChild(c1.el);
      his.appendChild(c2.el);

      function tick() {
        [c1, c2].forEach(function (c) {
          var now = new Date(Date.now() + c.offset * 3600000);
          function p(n) { return n < 10 ? '0' + n : '' + n; }
          c.t.textContent = p(now.getHours()) + ':' + p(now.getMinutes());
        });
      }
      tick();
      var timer = setInterval(tick, 15000);
      box.__cleanup = function () { clearInterval(timer); };

      box.appendChild(mine);
      box.appendChild(h('div', 'w-wc-divider'));
      box.appendChild(his);
      return box;
    },

    player: function (cell, ctx) {
      var box = h('div', 'widget w-player');
      var icEl = h('div', 'w-player-ic');
      icEl.innerHTML = ICONS.clock;
      box.appendChild(icEl);
      box.appendChild(h('div', 'w-player-text', '正在播放'));
      return box;
    },

    /* ---------------- 音乐卡（第 3 屏主件） ----------------
       用户给的参考是一张横版播放卡：左边一块方形封面，右边歌名 / 歌手 /
       「正在播放」，下面一排「上一首 · 播放 · 下一首」、一条进度条、
       右下角「随机播放」。用户的话是「不要这个颜色，但是大概长这样！
       做好看点好吗宝宝」—— 参考图是深紫黑的星空，跟这个项目的
       白 + 焦糖玻璃完全不搭。所以**版式照抄、材质整套换掉**：
       封面做成一块暖色圆胶（奶油底 + 焦糖螺线），按钮和进度条都是玻璃。

       注意它是**装饰性**的：没有真音频。进度条按曲子时长自己走
       （一条永远停在 1:18 不动的进度条看着就像坏了），播放键只管本地那一下。
       以后要接真播放器，把下面这几个常量换成 store 里的字段就行。 */
    music: function (cell, ctx) {
      var TOTAL = 272;                 /* 4:32 */
      var pos = Number(cell.at) || 78; /* 1:18 —— 参考图上停的位置 */
      var playing = !cell.paused;

      var box = h('div', 'widget w-music' + (playing ? ' is-playing' : ''));

      /* ---- 封面：暖色圆胶 ----
         螺线用 spiralPath 参数化生成；外面套一层 overflow:hidden 的圆，
         不需要 clipPath（clipPath 要 id，同一页出现两个实例就撞了）。 */
      var cover = h('div', 'w-music-cover');
      cover.innerHTML = musicCover();
      box.appendChild(cover);

      var main = h('div', 'w-music-main');

      main.appendChild(h('div', 'w-music-title', cell.title || '星轨钢琴曲'));
      main.appendChild(h('div', 'w-music-artist', cell.artist || '银河时光'));
      main.appendChild(h('div', 'w-music-state', '正在播放'));

      var ctrl = h('div', 'w-music-ctrl');
      function tbtn(name, svg) {
        var b = h('button', 'w-music-btn w-music-' + name);
        b.type = 'button';
        b.setAttribute('aria-label', name);
        b.innerHTML = svg;
        return b;
      }
      ctrl.appendChild(tbtn('prev', ic('<path d="M16 7.5v9M15 12l-7-4.5v9z"/>', 17)));
      var play = tbtn('play', '');
      ctrl.appendChild(play);
      ctrl.appendChild(tbtn('next', ic('<path d="M8 7.5v9M9 12l7-4.5v9z"/>', 17)));
      main.appendChild(ctrl);

      /* ---- 进度条 ---- */
      var bar = h('div', 'w-music-bar');
      var tNow = h('span', 'w-music-time');
      var track = h('span', 'w-music-track');
      var fill = h('span', 'w-music-fill');
      var knob = h('span', 'w-music-knob');
      track.appendChild(fill);
      track.appendChild(knob);
      var tAll = h('span', 'w-music-time', fmtClock(TOTAL));
      bar.appendChild(tNow);
      bar.appendChild(track);
      bar.appendChild(tAll);
      main.appendChild(bar);

      main.appendChild(h('div', 'w-music-mode', cell.mode || '随机播放'));
      box.appendChild(main);

      function fmtClock(s) {
        return Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2);
      }
      function paint() {
        var pct = Math.max(0, Math.min(1, pos / TOTAL));
        fill.style.width = (pct * 100).toFixed(2) + '%';
        knob.style.left = (pct * 100).toFixed(2) + '%';
        tNow.textContent = fmtClock(pos);
      }
      function paintPlay() {
        play.innerHTML = playing
          ? ic('<path d="M10 7.5v9M14 7.5v9"/>', 17)
          : ic('<path d="M9.5 7.2v9.6l8-4.8z"/>', 17);
        play.setAttribute('aria-label', playing ? '暂停' : '播放');
        box.classList.toggle('is-playing', playing);
      }
      paint();
      paintPlay();

      play.addEventListener('click', function () {
        playing = !playing;
        paintPlay();
      });

      /* 一秒一格。看着朴素，但这条时间线是整张卡「活着」的全部来源。
         和别的组件一样挂 __cleanup —— 重画时不清掉的话，
         每重画一次就多一个后台定时器（这个坑项目里踩过）。 */
      var timer = setInterval(function () {
        if (!playing) return;
        pos = pos >= TOTAL ? 0 : pos + 1;
        paint();
      }, 1000);
      box.__cleanup = function () { clearInterval(timer); };

      return box;
    },

    calendar: function (cell, ctx) {
      var box = h('div', 'widget w-calendar');
      var now = new Date();

      var left = h('div', 'w-cal-left');
      left.appendChild(h('div', 'w-cal-lunar', lunarText(now)));
      left.appendChild(h('div', 'w-cal-big', bigTime(now)));

      var dayRow = h('div', 'w-cal-dayrow');
      dayRow.appendChild(h('div', 'w-cal-day', String(now.getDate())));
      var ym = h('div', 'w-cal-ym');
      ym.appendChild(h('span', '', now.getFullYear() + '年' + (now.getMonth() + 1) + '月'));
      ym.appendChild(h('span', 'is-accent', '星期' + '日一二三四五六'.charAt(now.getDay())));
      dayRow.appendChild(ym);
      left.appendChild(dayRow);

      var right = h('div', 'w-cal-grid');
      var heads = ['日', '一', '二', '三', '四', '五', '六'];
      heads.forEach(function (x) {
        right.appendChild(h('div', 'w-cal-head', x));
      });
      var y = now.getFullYear(), m = now.getMonth();
      var first = new Date(y, m, 1).getDay();
      var days = new Date(y, m + 1, 0).getDate();
      for (var i = 0; i < first; i++) right.appendChild(h('div', '', ''));
      for (var d = 1; d <= days; d++) {
        var el = h('div', '', String(d));
        if (d === now.getDate()) el.className = 'w-cal-today';
        right.appendChild(el);
      }

      box.appendChild(left);
      box.appendChild(right);
      return box;
    },

    todo: function (cell, ctx) {
      var box = h('div', 'widget w-todo');
      var items = getTodos();

      var head = h('div', 'w-todo-head');
      var title = h('div', 'w-todo-title');
      var ti = h('span', 'w-todo-ic');
      ti.innerHTML = ICONS.todo;
      title.appendChild(ti);
      title.appendChild(h('span', '', 'To-Do'));
      head.appendChild(title);

      /* 进度：不做成百分比数字，用一句人话更贴「手机里的备忘录」这个语境 */
      var doneN = items.filter(function (t) { return t.done; }).length;
      head.appendChild(h('span', 'w-todo-count',
        items.length ? doneN + '/' + items.length : ''));
      box.appendChild(head);

      var list = h('div', 'w-todo-list');

      if (!items.length) {
        var empty = h('div', 'w-todo-empty');
        empty.appendChild(h('p', 'w-todo-empty-text', '还没有待办'));
        empty.appendChild(h('p', 'w-todo-empty-hint', '点下面加一条'));
        list.appendChild(empty);
      } else {
        /* 已完成沉到下面：备忘录的常规做法，也让冒头的事更清楚。
           先按 done 分两堆，再各自保持原顺序。 */
        var sorted = items.filter(function (t) { return !t.done; })
          .concat(items.filter(function (t) { return t.done; }));

        sorted.forEach(function (t) {
          var row = h('div', 'w-todo-item' + (t.done ? ' is-done' : ''));
          row.setAttribute('data-id', t.id);

          /* 复选框：整行可点，但勾选和删是两个动作，所以分行内两个热区。
             勾选框是专门的按钮，点文字行则是「编辑」。 */
          var check = h('button', 'w-todo-box' + (t.done ? ' is-done' : ''));
          check.type = 'button';
          check.setAttribute('aria-label', t.done ? '标记为未完成' : '标记为已完成');
          check.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleTodo(ctx, t.id);
          });
          row.appendChild(check);

          var text = h('span', 'w-todo-text', t.text);
          row.appendChild(text);

          var del = h('button', 'w-todo-del');
          del.type = 'button';
          del.setAttribute('aria-label', '删除');
          del.innerHTML = ic('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 14);
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            removeTodo(ctx, t.id);
          });
          row.appendChild(del);

          /* 点一下就**就地**改，不再弹那个 prompt 框 ——
             用户原话「点击就可以编辑文字~」。
             行是「直接在页面上」的（不再有卡片外框），再弹一个居中对话框
             就完全不是那个气质了。 */
          row.addEventListener('click', function () { editTodoInline(row, text, t, ctx); });
          list.appendChild(row);
        });
      }
      box.appendChild(list);

      var add = h('button', 'w-todo-add');
      add.type = 'button';
      add.innerHTML = ic('<path d="M12 6.5v11M6.5 12h11"/>', 16);
      add.appendChild(h('span', '', '加一条'));
      add.addEventListener('click', function () { addTodo(ctx); });
      box.appendChild(add);

      return box;
    },

    /* ---------------- 拍立得照片墙（第 0 屏，占满整屏） ----------------
       参考图（用户给的）是一张「电影胶片」拼贴海报：左上角一块场记板
       （CUT! / SCENE），右上角一盘胶片，中间撒一墙撕边的拍立得，
       最下面一条「下一镜头」。

       用户拍板了两件事：
         · **只搬结构、配色还是我们的** —— 深蓝底和撕纸边不要，
           底子仍是纯白 + 焦糖，和另外三屏连成一套；
         · **一整块**，不是拆成几个组件。
       所以这里是「版式照抄、材质换成我们那套」：场记板做成焦糖木牌 + 奶油斜纹，
       胶片盘是线稿，拍立得沿用原来的纸卡 + 胶带，底下的按钮做成一截纸带。

       组件本身**不带玻璃底**（同 .w-hdr / .w-todo / .w-music）——
       一整面墙再套个圆角卡，就不是「贴在墙上」而是「装在相框里」了。 */
    /* ---------------- 照片墙（第 0 屏，占满整屏） ----------------
       参考图是一张「电影胶片」海报：左上角一块**大**场记板（CUT! / SCENE、
        板面带一圈内框），旁边一条胶片，下面一片**固定模板**的相框格。

       第十三版（用户两条反馈）：
         1. 「cut 的组件做大一些，仿照参考图，右边那个太丑了，换成别的好看点的」
            → 场记板放大 + 板面加内框；胶片盘整个撤掉，换成**竖胶片条**
            （齿孔 + 三个格，线稿，比那两圈圆孔耐看得多）。
         2. 「不要这样的粘贴~ 做成固定的模板吧，点击那里可以加照片，
            也是按照这个固定的样子来做！不要那个贴的胶布」
            → 撤掉全部胶带和旋转，相框是**写死的网格模板**
            （三行：3 + 2 + 大幅跨行 + 3，像参考图那样中间一张大的），
            空格上是一个淡的加号，点了就选照片填进这个格。 */
    wall: function (cell, ctx) {
      var box = h('div', 'widget w-wall');
      var photos = wallPhotos();

      /* ---- 顶带：场记板 + 胶片条 ---- */
      var top = h('div', 'w-wall-top');

      var clap = h('div', 'w-wall-clap');
      var bar = h('div', 'w-wall-clap-bar');
      bar.appendChild(h('i', null));
      clap.appendChild(bar);
      var clapBody = h('div', 'w-wall-clap-body');
      /* 内框：参考图的板面里有一圈细白线，是「板」的辨识度所在。
         用独立 span 而不是 box-shadow —— 圆角处的框要跟着圆角走。 */
      clapBody.appendChild(h('i', 'w-wall-clap-frame'));
      clapBody.appendChild(h('div', 'w-wall-clap-cut', 'CUT!'));
      var scene = h('div', 'w-wall-clap-scene');
      scene.appendChild(h('span', 'w-wall-clap-lbl', 'SCENE'));
      scene.appendChild(h('span', 'w-wall-clap-no', '01'));
      clapBody.appendChild(scene);
      clap.appendChild(clapBody);
      top.appendChild(clap);

      /* ---- 竖胶片条：齿孔 + 三个格 ----
         全由循环生成，想改格数/齿孔数动两个数就行。 */
      var strip = h('div', 'w-wall-strip');
      var svg = '<svg viewBox="0 0 44 100" aria-hidden="true" preserveAspectRatio="none">';
      svg += '<rect class="w-wall-strip-body" x="2" y="2" width="40" height="96" rx="4"/>';
      for (var py = 9; py <= 88; py += 13.2) {
        svg += '<rect class="w-wall-strip-perf" x="7" y="' + py + '" width="4.2" height="5"/>';
        svg += '<rect class="w-wall-strip-perf" x="32.8" y="' + py + '" width="4.2" height="5"/>';
      }
      for (var fy = 0; fy < 3; fy++) {
        svg += '<rect class="w-wall-strip-frame" x="14" y="' + (10 + fy * 29) +
          '" width="16" height="23" rx="1.5"/>';
      }
      svg += '</svg>';
      strip.innerHTML = svg;
      top.appendChild(strip);
      box.appendChild(top);

      /* ---- 固定模板的相框格 ----
         8 个格子的位置是写死的（6 列 × 4 行，中间那格跨两行当「大幅」），
         不旋转、不胶带 —— 用户明确要「固定的模板」。
         照片按顺序填进前面的格子，剩下的格子是空框，
         上面一个淡的加号，点了选照片填进这个格。 */
      var SPOTS = [
        '1 / 1 / 2 / 3',
        '1 / 3 / 2 / 5',
        '1 / 5 / 2 / 7',
        '2 / 1 / 3 / 3',
        '2 / 3 / 4 / 7',   /* 大幅 */
        '3 / 1 / 4 / 3',
        '4 / 1 / 5 / 4',
        '4 / 4 / 5 / 7'
      ];

      var grid = h('div', 'w-wall-grid');
      SPOTS.forEach(function (area, i) {
        var p = photos[i];
        var slot = h('button', 'w-wall-slot' + (p ? '' : ' is-empty'));
        slot.type = 'button';
        slot.style.gridArea = area;

        var ph = h('span', 'w-wall-slot-ph');
        if (p) {
          /* 异步取地址：新照片在 IndexedDB 里（拿 objectURL），老记录是 dataURL */
          if (Sleepy.photos && Sleepy.photos.srcOf) {
            Sleepy.photos.srcOf(p).then(function (src) {
              if (src) ph.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
            });
          }
          slot.title = (p.caption || '') + ' · 点下面「下一镜头」再加';
        } else {
          slot.innerHTML = ic('<path d="M12 7.5v9M7.5 12h9"/>', 15);
          slot.setAttribute('aria-label', '加照片');
          slot.addEventListener('click', function () { addWallPhotos(ctx); });
        }
        slot.appendChild(ph);
        grid.appendChild(slot);
      });
      box.appendChild(grid);

      return finish(box, ctx);
    }
  };

  /* ---------------- 主屏下拉：选一段存档降落 ----------------
     拉手（日期头右边那个坠子）拉开后，桌面往后仰，前面垂下来一叠
     「岛卡」—— 每张卡是一段存档（孤岛 / 群岛），点一张就降落过去。
     数据和行为都照抄浮岛 App 的 landInto：setActiveSandbox + 摸一下
     usedAt + 回桌面重画。差别只在入口：这里是桌面上的拉手，
     不用绕进浮岛再出来。

     面板挂在 .page 这一层（同放大态的灯）：.page 上有 transform，
     fixed 的包含块正好是一块手机屏；而且 .dt-scroll 是个层叠上下文，
     面板塞在里面会被底栏压住。桌面后仰也做在 .page 上（is-pulled）。 */
  function openCharPull(ctx) {
    var page = document.querySelector('.page');
    if (!page || page.querySelector('.dt-pull-scrim')) return;   /* 防重入 */

    var list = (core.listSandboxes() || []).slice();
    var cur = core.activeSandbox();
    /* 当前的排最上，其余按最近用过的在前 —— 「回去哪」比「有哪些」常用 */
    list.sort(function (a, b) {
      function key(x) {
        if (cur && x.id === cur.id) return Infinity;
        return x.usedAt || x.updatedAt || x.createdAt || 0;
      }
      return key(b) - key(a);
    });

    var scrim = h('div', 'dt-pull-scrim');
    var panel = h('div', 'dt-pull');
    panel.appendChild(h('div', 'dt-pull-head', '降落去哪一段'));

    if (!list.length) {
      panel.appendChild(h('p', 'dt-pull-empty', '还没有岛，去浮岛 App 建一座'));
    }

    list.forEach(function (sb, i) {
      var isCur = !!(cur && sb.id === cur.id);
      var chars = core.charsOfSandbox(sb);
      /* 决策 4：群岛多人要先选角色。这时候这张段卡不是降落目标，
         只是分组头；真正的卡是下面一人一张的角色卡 ——
         「手风琴式角色卡」指的就是这个。其余情况段卡本身就是目标。 */
      var pickChar = core.needsCharPick(sb);
      var card = h('button', 'dt-pull-card' + (isCur ? ' is-current' : '') +
        (pickChar ? ' is-group' : ''));
      card.type = 'button';
      /* 手风琴：每张卡错开一拍落下来 */
      card.style.transitionDelay = (70 + i * 45) + 'ms';

      var av = h('span', 'dt-pull-av',
        (chars[0] && chars[0].name ? chars[0].name : (sb.kind === core.KIND_ARCHI ? '群' : '岛')).slice(0, 1));
      card.appendChild(av);

      var main = h('span', 'dt-pull-main');
      main.appendChild(h('span', 'dt-pull-name', pullRoomTitle(sb)));
      var bits = [sb.kind === core.KIND_ARCHI ? '群岛' : '孤岛'];
      if (chars.length) bits.push(chars.length + ' 人');
      if (!isCur && (sb.usedAt || sb.createdAt)) bits.push('上次 ' + shortDate(sb.usedAt || sb.createdAt));
      main.appendChild(h('span', 'dt-pull-sub', bits.join(' · ')));
      card.appendChild(main);

      if (isCur) card.appendChild(h('span', 'dt-pull-now', '降落中'));

      if (pickChar) {
        card.addEventListener('click', function () {
          card.classList.toggle('is-open');
        });
      } else {
        card.addEventListener('click', function () { land(sb, chars[0]); });
      }
      panel.appendChild(card);

      /* 群岛多人：一人一张角色卡，点了带着这个角色降落。
         「对应的 user」= 这间房里的第一件马甲（maskIds[0]）——
         马甲本来就按房分组（决策 8），聊天里「我」是谁由它决定。 */
      if (pickChar) {
        var subs = h('div', 'dt-pull-chars');
        /* 打「当前身份」标记也过卫兵，与 skin() 同口径 ——
           isCur 已保证这是当前岛，指针指向别岛的人时这里自然不打标。 */
        var curOnIsland = core.activeCharOnIsland ? core.activeCharOnIsland() : core.activeChar();
        chars.forEach(function (c, j) {
          var cc = h('button', 'dt-pull-char' +
            (isCur && curOnIsland && c.id === curOnIsland.id ? ' is-current' : ''));
          cc.type = 'button';
          cc.style.transitionDelay = (110 + i * 45 + j * 35) + 'ms';
          cc.appendChild(h('span', 'dt-pull-char-av',
            (c.name || '?').slice(0, 1)));
          var cm = h('span', 'dt-pull-char-main');
          cm.appendChild(h('span', 'dt-pull-char-name', c.name || '未命名'));
          if (c.persona) {
            cm.appendChild(h('span', 'dt-pull-char-sub',
              String(c.persona).replace(/\s+/g, ' ').slice(0, 24)));
          }
          cc.appendChild(cm);
          cc.addEventListener('click', function () { land(sb, c); });
          subs.appendChild(cc);
        });
        panel.appendChild(subs);
      }
    });

    panel.appendChild(h('p', 'dt-pull-hint', '点一段就降落 · 点空白处返回'));
    scrim.appendChild(panel);

    function close() {
      scrim.classList.remove('is-open');
      page.classList.remove('is-pulled');
      setTimeout(function () {
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      }, 340);
    }
    scrim.addEventListener('click', function (e) {
      if (e.target === scrim) close();
    });

    function land(sb, char) {
      var r = core.setActiveSandbox(sb.id);
      if (!r.ok) { ctx.toast(r.message, 'err'); return; }
      /* 身份跟着岛走（用户的设计）：降进哪段，「我」和「对方」就是那段里的。
         char 是点的哪张角色卡；「我」取这间房的**大号**（isDefault）——
         马甲按房分组（决策 8），聊天里「我」是谁由它决定。
         以前取的是名册第一件，跟「我的大号」是两回事（用户 2026-09-21 拍板）。 */
      var bigMe = core.defaultUserOfSandbox ? core.defaultUserOfSandbox(sb) : null;
      core.switchTo(char ? char.id : undefined, bigMe ? bigMe.id : undefined);
      var all = core.listSandboxes();
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === sb.id) {
          all[i].usedAt = Date.now();
          all[i].updatedAt = Date.now();
        }
      }
      core.saveSandboxes(all);
      close();
      /* 换岛 = 换数据也换视觉：岛的穿着/主题覆盖跟着活动岛重放
         （岛覆盖 > 全局）。不重放的话，新岛还穿着上一座岛的衣服。 */
      if (Sleepy.appearance && Sleepy.appearance.apply) Sleepy.appearance.apply();
      if (ctx.repaint) ctx.repaint();
      ctx.toast('降落了', 'ok');
    }

    page.appendChild(scrim);
    /* 两帧之后再翻 is-open：保证初始态（没开）先被浏览器记下来，
       过渡才跑得起来 —— 一帧有时不够，稳一点用两帧。 */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        scrim.classList.add('is-open');
        page.classList.add('is-pulled');
      });
    });
  }

  /* 标题：跟 page-island 的 roomTitle 同一套规矩 —— 手动起的名字优先，
     没起名用房里的人。这边放一份小的而不去引浮岛模块：
     page-island 是按需加载的页面，桌面不为一个标题多背一次依赖。 */
  function pullRoomTitle(sb) {
    if (sb && sb.name) return sb.name;
    var chars = core.charsOfSandbox(sb);
    if (!chars.length) return sb.kind === core.KIND_ARCHI ? '空着的一片群岛' : '空着的一座岛';
    if (chars.length === 1) return chars[0].name || '未命名';
    if (chars.length <= 3) {
      var names = [];
      for (var i = 0; i < chars.length; i++) names.push(chars[i].name || '未命名');
      return names.join('、');
    }
    return (chars[0].name || '未命名') + ' 等 ' + chars.length + ' 人';
  }

  /* ---------------------------- 照片墙数据 ---------------------------- */

  /* 照片存在 store 的 'photos'，负一屏和相册 App 是**同一份数据**
     （不是各存各的）。但**按沙盒过滤** —— 照片墙只贴这间房里的照片，
     别的存档的私房照不该出现在这里。 */
  /* 照片墙的收尾：底下那条「下一镜头」。
     参考图里那条纸带本来就是「继续拍下一镜」的意思，所以它
     直接接**加照片**这个动作（右上角那个小加号是同一个动作的第二条路，
     留着给已经习惯它的人）。 */
  function finish(box, ctx) {
    var next = h('button', 'w-wall-next');
    next.type = 'button';
    /* 兰波那句「La vie est ailleurs」（生活在别处）——
       用户要「花体的一句意大利语或者法语里的自由诗」。
       选这句：够短（纸带就一条），意思和负一屏（照片墙＝留在别处的瞬间）正好对上。
       字体走系统花体栈，见 .w-wall-next 的 font-family。
       aria-label 保留中文，读屏的人听到的还是「下一镜头」。 */
    next.appendChild(h('span', 'w-wall-next-text', 'La vie est ailleurs'));
    next.title = '下一镜头 · 加一张照片';
    next.setAttribute('aria-label', '下一镜头，加一张照片');
    next.addEventListener('click', function () { addWallPhotos(ctx); });
    box.appendChild(next);

    /* 右上角的小加号撤掉了（第十三版）：相框格本身就是加照片的入口，
       空格上自带加号，顶上再挂一个反而和状态栏挤在一起。 */
    return box;
  }

  function wallPhotos() {
    var list = store.get('photos');
    if (!Array.isArray(list)) return [];
    return core.scoped(list);
  }

  function shortDate(at) {
    var d = new Date(at || Date.now());
    return (d.getMonth() + 1) + '.' + d.getDate();
  }

  /* 选图 → 交给 photos 数据层落库。
     图片本体在 IndexedDB 图库里，存档里只留 mediaId（photos.js 负责
     缩放 / 配额 / 新老记录兼容）。这里以前写的是「localStorage 只有 5MB，
     必须缩放后再存」—— 那是接 IDB 之前的说法，已经不准了（2026-09-21）。 */
  function addWallPhotos(ctx) {
    if (!Sleepy.photos || !Sleepy.photos.pick) {
      ctx.toast('相册模块没加载出来', 'err');
      return;
    }
    Sleepy.photos.pick({ title: '加进照片墙' }).then(function (added) {
      if (!added || !added.length) return;
      ctx.toast('加了 ' + added.length + ' 张', 'ok');
      if (ctx.repaint) ctx.repaint();
    });
  }

  function bigTime(d) {
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 农历只做到「大致准」：这里没有完整的历法表，硬算会出错，
     所以显示节气区间 + 提示。真正要准得引一份农历数据，属于软装。 */
  function lunarText(d) {
    var m = d.getMonth() + 1;
    return d.getFullYear() + ' · 第 ' + Math.ceil((d.getDate() + new Date(d.getFullYear(), m - 1, 1).getDay()) / 7) + ' 周';
  }

  /* 待办的数据读写。存 store 的 'todos'。

     ---- 两个口子，不要混用 ----
     getTodos()       当前房可见的。**读取方（渲染）用**。
     writableTodos()  全量。**写入方用** —— 改完整表落盘。
       写入方误用 getTodos() 的话，set 回去的是一份被沙盒过滤过的列表，
       别的存档的待办会被整批抹掉（切个房间回来发现待办没了）。

     还有一条老规矩：**第一次打开**（key 不存在）落一份示例，
     免得新用户看到一个空盒子以为组件坏了；而且必须真的写回 store，
     不能只 return 一份临时数组（否则勾选框改的是转瞬即逝的副本）。
     判断用「key 在不在」而不是「数组空不空」，
     这样用户手动删光之后不会自己长回来。 */
  function allTodos() {
    var list = store.get('todos');
    return Array.isArray(list) ? list : null;   /* null = 这个键还没被建过 */
  }

  function seedTodos() {
    var seed = [
      { id: 'td1', text: '去超市买草莓', done: true },
      { id: 'td2', text: '给猫猫洗澡', done: false },
      { id: 'td3', text: '晚上和他连麦', done: false }
    ];
    seed.forEach(function (t) { if (core.tagScope) core.tagScope(t); });
    store.set('todos', seed);
    return seed;
  }

  function getTodos() {
    var full = allTodos();
    return full === null ? seedTodos() : core.scoped(full);
  }

  function writableTodos() {
    var full = allTodos();
    return full === null ? seedTodos() : full;
  }

  function saveTodos(list) { return store.set('todos', list); }

  /* 复选框 / 文字 / 删除都改这一份 list，改完写回并整块重画。
     重画而不是就地改 DOM：一是删行之后索引会错位，
     二是重画顺便让「已完成 N/M」的进度条跟着更新。 */
  function toggleTodo(ctx, id) {
    var list = writableTodos();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { list[i].done = !list[i].done; break; }
    }
    saveTodos(list);
    if (ctx.repaint) ctx.repaint();
  }

  function removeTodo(ctx, id) {
    saveTodos(writableTodos().filter(function (t) { return t.id !== id; }));
    if (ctx.repaint) ctx.repaint();
  }

  /* 就地编辑一条待办。
     和上面那个 prompt 版的区别：这里不弹窗，直接把文字换成一根下划线的
     输入框，回车/失焦存，Esc 取消。
     两个容易漏的点：
       · 输入框自己的 click 要 stopPropagation，否则点一下光标就被
         「换成输入框」那次点击又触发一遍；
       · 行上的 is-editing 是给重画用的 —— 编辑中如果来了 repaint，
         整行会被换成只读的文本，正在打的东西就没了。 */
  function editTodoInline(row, textEl, t, ctx) {
    if (row.classList.contains('is-editing')) return;
    row.classList.add('is-editing');

    var input = h('input', 'w-todo-input');
    input.type = 'text';
    input.value = t.text;
    input.setAttribute('aria-label', '编辑待办');
    textEl.style.display = 'none';
    row.insertBefore(input, textEl.nextSibling);
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* 某些输入法下不支持 */ }

    var closed = false;
    function finish(save) {
      if (closed) return;
      closed = true;
      var v = String(input.value || '').trim();
      if (save && v && v !== t.text) {
        var list = writableTodos();
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === t.id) list[i].text = v;
        }
        saveTodos(list);
        textEl.textContent = v;
      } else if (save && !v) {
        ctx.toast('不能是空的', 'warn');
      }
      row.classList.remove('is-editing');
      if (input.parentNode) input.parentNode.removeChild(input);
      textEl.style.display = '';
    }

    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  function editTodo(ctx, id) {
    var list = writableTodos();
    var hit = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) hit = list[i];
    if (!hit) return;
    ui.prompt({
      title: '改一下',
      value: hit.text,
      placeholder: '要做什么？'
    }).then(function (v) {
      if (v === null) return;                 /* 取消 */
      var text = String(v).trim();
      if (!text) { ctx.toast('不能是空的', 'warn'); return; }
      var l2 = writableTodos();
      for (var j = 0; j < l2.length; j++) if (l2[j].id === id) l2[j].text = text;
      saveTodos(l2);
      if (ctx.repaint) ctx.repaint();
    });
  }

  function addTodo(ctx) {
    ui.prompt({
      title: '加一条待办',
      placeholder: '比如：给他寄一箱橘子'
    }).then(function (v) {
      if (v === null) return;
      var text = String(v).trim();
      if (!text) { ctx.toast('不能是空的', 'warn'); return; }
      var list = writableTodos();
      var item = { id: core.newId('td'), text: text, done: false };
      if (core.tagScope) core.tagScope(item);
      list.push(item);
      saveTodos(list);
      if (ctx.repaint) ctx.repaint();
    });
  }

  function cycleMood(ctx) {
    /* 写路径过卫兵：指针停在上一个岛的人身上时，绝不能把心情写过去 */
    var c = core.activeCharOnIsland ? core.activeCharOnIsland() : core.activeChar();
    if (!c) { ctx.toast('这座岛还没选人 —— 用桌面下拉或切号器选一位', 'warn'); return; }
    var cur = c.mood || skin().mood;
    var idx = MOODS.indexOf(cur);
    var next = MOODS[(idx + 1 + MOODS.length) % MOODS.length];
    saveActive({ mood: next, moodAt: Date.now() });
    ctx.toast('心情：' + next, 'ok');
    if (ctx.repaint) ctx.repaint();
  }

  /* ---------------------------- 系统级切号（时空切换器） ---------------------------- */

  /* 总纲：「不限定为特定图标，而是系统级的一个切换菜单/入口」。
     这里做成从底部升起的浮层，列出所有大号 + 当前大号的全部皮套。
     选定之后整个 OS 换肤 —— 不是只换一个 App 里的数据。 */
  function openSwitcher(ctx) {
    var s = Sleepy.switcher;
    if (!s || !s.open) { ctx.toast('切号面板没加载出来', 'err'); return; }
    s.open(ctx);
  }

  /* ---------------------------- 布局编辑（长按拖动） ----------------------------

     这一整块是「桌面自己会动」的能力：长按任意组件 → 整屏进入编辑态
     （网格底纹显形、组件轻轻抖一下）→ 拖到别的格子 → 松手落位、写回存档。

     ---- 为什么要单独做手势，而不是用现成的 ----
     app.js 里已经有一套「边缘右滑返回」，它是 document 级的、只认屏幕左边缘。
     桌面这套是**组件级**的，起手位置在组件身上，两者靠起手坐标天然错开。
     但有个真冲突：角色卡原本「点一下 = 切号」，长按拖动会让点击变得可疑。
     解法见下面 bindCell 的注释 —— 长按期间吞掉后续 click。

     ---- 拖的是「落点」不是「跟手」 ----
     拖动时组件跟手走（translate），但**目标格子**按中心点吸附到格子坐标上，
     松手时只做整格吸附。这样布局永远合法，不会出现「停在两个格子中间」
     的半格状态，也就没有「下次渲染它对不上」的问题。 */

  var EDIT_MS = 420;        /* 长按判定时长。太短会误触（点一下就进编辑），太长像卡住 */
  var MOVE_TOL = 12;        /* 判定「这是拖动不是长按」的位移阈值 */
  var editing = false;      /* 编辑态：网格显形、组件可拖 */
  var editTimer = null;     /* 长按计时器 */
  var editCtx = null;       /* 当前编辑态所属的页面 ctx */
  var dragState = null;     /* 正在拖的那一格 */

  function isEditing() { return editing; }

  /* 当前可见的是第几屏。靠 scroller 的 scrollLeft 算，**不要**用
     getBoundingClientRect 跟视口比 —— 桌面是嵌在手机壳里的，
     rect 的坐标系和视口差着外层容器的偏移，算出来永远是错的
     （踩过：进编辑态时第 2 屏拿不到 is-editing，网格不显形，
     看着就像长按没反应）。 */
  function currentScreenIndex(ctx) {
    var scroller = ctx && ctx.body && ctx.body.querySelector('.dt-scroll');
    if (!scroller || !scroller.clientWidth) return -1;
    return Math.max(0, Math.min(PAGES - 1, Math.round(scroller.scrollLeft / scroller.clientWidth)));
  }

  function paintEditState(on) {
    var ctx = editCtx;
    if (!ctx || !ctx.body) return;
    var screens = ctx.body.querySelectorAll('.dt-screen');
    var cur = currentScreenIndex(ctx);
    for (var i = 0; i < screens.length; i++) {
      /* 只给当前那一屏加编辑态。别的屏在屏幕外，加了看不见，
         翻过去还莫名其妙地是编辑态。 */
      screens[i].classList.toggle('is-editing', on && i === cur);
    }
    ctx.body.classList.toggle('is-editing', on);
  }

  function enterEdit(ctx, quiet) {
    if (editing) return;
    editing = true;
    editCtx = ctx;
    paintEditState(true);
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(12); } catch (e) { /* 桌面浏览器没有，忽略 */ }
    }
    /* quiet：删完一个组件之后自动回到编辑态，这次不用再教一遍 */
    if (!quiet) ctx.toast('拖到别的格子，或者点空白处退出', 'ok');
  }

  function exitEdit() {
    if (editing) {
      editing = false;
      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      if (dragState) cancelCellDrag();
      paintEditState(false);
      editCtx = null;
    }
    /* 即使不进编辑态也要清计时器 —— 拖着没放手就重画的情况下，
       计时器会在节点已经销毁之后把编辑态又点起来。 */
    if (editTimer) { clearTimeout(editTimer); editTimer = null; }
    if (dragState) cancelCellDrag();
  }

  var GRID_GAP = 16;

  /* 一格的边长（含 gap 的步长另算）。
     **不要 parseFloat(getComputedStyle(--dt-cell))** —— 那个变量是一段
     没解析的 calc() 字符串（"--dt-cell: calc((480px - 40px - 3 * 16px) / 4)"），
     parseFloat 读到第一个非数字就返回 NaN，于是静默落到兜底值 72，
     而真实格子是 98px —— 吸附位置全错，而且不报任何错。
     直接量 DOM。

     **grid 必须显式传进来。** 早先这里写的是
     `ctx.body.querySelector('.dt-grid')`，它永远返回**第 0 屏**的网格，
     而拖的可能是第 2 屏 —— 于是原点差了整整两屏宽，
     吸附结果全跑到右边去了（踩过：明明拖到第 2 列，落点算出来是第 4 列）。 */
  function cellStep(grid, ctx) {
    var g = grid || (ctx && ctx.body ? ctx.body.querySelector('.dt-grid') : null)
      || document.querySelector('.dt-grid');
    if (g) {
      /* 用网格实际宽度反推步长最稳：4 列 + 3 个 gap。
         比读 CSS 变量可靠，也比「找一个 1×1 的子元素」稳
         （那一屏可能没有 1×1 的组件）。 */
      var gw = g.getBoundingClientRect().width;
      if (gw > 0) return (gw - (COLS - 1) * GRID_GAP) / COLS + GRID_GAP;
    }
    /* 兜底：跟 style.css 的宽屏上限公式一致 */
    return (480 - 40 - 3 * 16) / 4 + GRID_GAP;
  }

  /* 网格在屏幕上的原点（左上角）。同样必须传对 grid。 */
  function gridOrigin(grid, ctx) {
    var g = grid || (ctx && ctx.body ? ctx.body.querySelector('.dt-grid') : null);
    if (!g) return { x: 0, y: 0 };
    var r = g.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  /* 把落点吸附成格子坐标，并保证不越界。
     越界不报错、直接夹住 —— 拖到屏幕外一格是很容易发生的操作，
     报错弹窗比「不动」更烦人。 */
  function snapTo(grid, ctx, left, top, w, h) {
    var step = cellStep(grid, ctx);
    var o = gridOrigin(grid, ctx);
    var gx = Math.round((left - o.x) / step) + 1;
    var gy = Math.round((top - o.y) / step) + 1;
    gx = Math.max(1, Math.min(COLS - w + 1, gx));
    gy = Math.max(1, Math.min(ROWS - h + 1, gy));
    return { x: gx, y: gy };
  }

  /* 某一格能不能落在这里：不越界、不压在**别的**组件上。
     跟 migrateDesktop 用的是同一个 overlap —— 就一个判交函数，
     渲染、迁移、拖拽三处共用，避免三份实现慢慢跑偏。 */
  function canPlace(pages, pi, cell, x, y) {
    if (x < 1 || y < 1 || x + cell.w - 1 > COLS || y + cell.h - 1 > ROWS) return false;
    var list = pages[pi] || [];
    var probe = { x: x, y: y, w: cell.w, h: cell.h };
    for (var i = 0; i < list.length; i++) {
      if (list[i] === cell || list[i].i === cell.i) continue;
      if (overlap(probe, list[i])) return false;
    }
    return true;
  }

  function persistCell(ctx, pi, cellId, x, y) {
    var d = getDesktop();
    var list = d.pages[pi] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].i !== cellId) continue;
      list[i].x = x; list[i].y = y;
    }
    /* 整体写回 —— 走 setDesktop（岛覆盖 > 全局）。store.set 存的是 JSON 字符串，
       改一份新的再存，不去原地改深拷贝（store.get 返回的是副本）。 */
    setDesktop(d);
  }

  function cancelCellDrag() {
    if (!dragState) return;
    var st = dragState;
    dragState = null;
    st.node.style.transform = '';
    st.node.classList.remove('is-dragging');
    if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost);
    if (st.grid) st.grid.classList.remove('is-drop-target');
    /* 跨屏拖到一半被打断（重画 / 退出编辑）：节点可能已经挂在别的屏的
       DOM 里，但存档还在源屏 —— 挪回去，别留下两处对不上。 */
    if (st.scaf) {
      st.scaf.scroller.style.scrollBehavior = '';
      if (st.pi !== st.srcPi && st.scaf.grids[st.srcPi]) {
        st.scaf.grids[st.srcPi].appendChild(st.node);
      }
    }
  }

  /* 给一个组件绑上「长按 → 拖动」。
     注意与页面本身的点击关系：
     · 非编辑态：长按 420ms 才进编辑态；期间只要手指移动超过阈值就放弃
       （那是用户在滑屏，不是在长按）。真正的点击不受影响。
     · 编辑态：单击 = 选中（先不做选中态，先只做拖动）；
       拖动直接生效，不再需要长按。 */
  function bindCell(node, cell, pi, ctx) {
    var down = null;

    function pos(e) {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;   /* 只认左键 */
      var p = pos(e);
      down = { x: p.x, y: p.y, t: Date.now(), moved: false, node: node };

      if (editing) {
        /* 编辑态里立刻起拖，不等待 */
        e.preventDefault();
        startCellDrag(node, cell, pi, ctx, p);
        return;
      }

      /* 非编辑态：排一个长按计时器。
         setTimeout 而不是看时间戳 —— 用户按住不动的时候没有任何事件，
         只能靠计时器把「按住」这件事变成一次动作。

         **计时器到点时手指还按着** —— 这一刻要顺手把拖动也接上，
         否则用户长按之后必须抬手再按一次才能拖，手感是断的
         （踩过：进编辑态了，但直接拖不动，看着像没生效）。 */
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(function () {
        editTimer = null;
        if (!down || down.moved) return;
        node.__longPressed = true;
        enterEdit(ctx);
        startCellDrag(node, cell, pi, ctx, { x: down.x, y: down.y });
      }, EDIT_MS);
    }

    function onMove(e) {
      if (!down) return;
      var p = pos(e);
      if (Math.abs(p.x - down.x) > MOVE_TOL || Math.abs(p.y - down.y) > MOVE_TOL) {
        /* 动了就不是长按 —— 用户在滑屏翻页，把计时器撤了。
           不撤的话滑到一半突然进编辑态，很难受。 */
        if (!dragState && editTimer) { clearTimeout(editTimer); editTimer = null; }
        down.moved = true;
      }
      if (dragState) moveCellDrag(p);
    }

    function onUp(e) {
      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      if (dragState) {
        var p = pos(e);
        endCellDrag(p, ctx);
      }
      down = null;
    }

    /* 长按进编辑态之后，同一次按键抬手会补一个 click。
       角色卡那样「点一下切号」的组件会被这一下误触发，所以要吞掉。 */
    function onClick(e) {
      if (node.__longPressed) {
        node.__longPressed = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      /* 「拿掉」的小叉叉放行 —— 这一层是**捕获阶段**，
         一刀切会把组件里所有按钮的点击一起吞掉（小叉叉就点不动了）。 */
      var t = e.target;
      if (t && t.closest && t.closest('.dt-kill')) return;
      if (editing) {
        /* 编辑态下点组件本身不做事（点空白处才退出） */
        e.preventDefault();
        e.stopPropagation();
      }
    }

    if (global.PointerEvent) {
      node.addEventListener('pointerdown', function (e) {
        onDown(e);
        if (editing) node.setPointerCapture && node.setPointerCapture(e.pointerId);
      });
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    } else {
      node.addEventListener('touchstart', onDown, { passive: false });
      node.addEventListener('touchmove', onMove, { passive: false });
      node.addEventListener('touchend', onUp);
      node.addEventListener('touchcancel', onUp);
      node.addEventListener('mousedown', onDown);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    node.addEventListener('click', onClick, true);   /* 捕获阶段先拦 */
  }

  /* 拖到屏幕左右边缘多近就翻到相邻那一屏 */
  var DRAG_EDGE = 46;

  /* 拖拽要用到的那几样东西：滚动容器 + 每一屏的网格。
     以前只认「起点那一屏」，所以组件永远出不了自己那一屏
     （用户 2026-09-21：「组件和 app 还不可以跨屏幕移动喔」）。 */
  function dragScaffold(ctx) {
    var body = ctx && ctx.body;
    if (!body) return null;
    var scroller = body.querySelector('.dt-scroll');
    if (!scroller) return null;
    var screens = body.querySelectorAll('.dt-screen');
    var grids = [];
    for (var i = 0; i < screens.length; i++) {
      grids.push(screens[i].querySelector('.dt-grid'));
    }
    return { scroller: scroller, screens: screens, grids: grids };
  }

  function startCellDrag(node, cell, pi, ctx, p) {
    var grid = node.parentNode;
    var ghost = h('div', 'dt-ghost');
    ghost.style.gridArea = node.style.gridArea;
    grid.appendChild(ghost);

    node.classList.add('is-dragging');
    node.style.zIndex = 40;

    var scaf = dragScaffold(ctx);
    /* 拖拽期间把 scroll-behavior 收成 auto：下面换屏是「同一帧里
       挪节点 + 挪滚动位置」，smooth 会让滚动慢慢追，看着像组件被扯掉。 */
    if (scaf) scaf.scroller.style.scrollBehavior = 'auto';

    dragState = {
      node: node, cell: cell, pi: pi, grid: grid, ghost: ghost,
      ctx: ctx,
      srcPi: pi,
      scaf: scaf,
      /* 「蹭边缘翻屏」的一次性开关。翻过去之后指针还停在边缘区里，
         如果不管它，下一帧 relX 依然超界 → 又翻一屏 → 一路翻到最后一屏，
         用户根本落不到中间那几屏。所以翻完就卸武装，
         必须先把指针挪回中间区才重新武装（一次边缘 = 一屏）。 */
      edgeArmed: true,
      off: { x: p.x, y: p.y },
      origin: { x: cell.x, y: cell.y }
    };
    grid.classList.add('is-drop-target');
  }

  /* 换到另一屏去：幽灵、被拖的节点、网格高亮、滚动位置一起挪。
     节点和滚动**同向同幅**地动（都是 clientWidth），所以在视口里
     看着是原地不动的 —— 不用去补 translate 的偏移。 */
  function switchDragScreen(pi) {
    var st = dragState;
    if (!st || !st.scaf) return;
    var grids = st.scaf.grids;
    if (!grids[pi] || !grids[st.pi]) return;

    st.grid.classList.remove('is-drop-target');
    st.pi = pi;
    st.grid = grids[pi];
    st.grid.classList.add('is-drop-target');
    st.grid.appendChild(st.ghost);      /* appendChild = 移动，不用先摘 */
    st.grid.appendChild(st.node);

    var w = st.scaf.scroller.clientWidth || 0;
    st.scaf.scroller.scrollLeft = pi * w;
    /* 目标屏也要显形网格（paintEditState 按 scrollLeft 判当前屏） */
    paintEditState(true);
  }

  function moveCellDrag(p) {
    if (!dragState) return;
    var st = dragState;
    var dx = p.x - st.off.x;
    var dy = p.y - st.off.y;
    st.node.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.06)';

    /* ---- 蹭到左右边缘就翻到相邻那一屏 ---- */
    if (st.scaf && st.scaf.scroller.clientWidth) {
      var box = st.scaf.scroller.getBoundingClientRect();
      var relX = p.x - box.left;
      /* 回到中间区 = 重新武装，允许下一次蹭边翻屏 */
      if (relX >= DRAG_EDGE && relX <= box.width - DRAG_EDGE) st.edgeArmed = true;
      var want = st.pi;
      if (relX < DRAG_EDGE) want = st.pi - 1;
      else if (relX > box.width - DRAG_EDGE) want = st.pi + 1;
      want = Math.max(0, Math.min(PAGES - 1, want));
      if (want !== st.pi && st.edgeArmed) {
        st.edgeArmed = false;
        switchDragScreen(want);
      }
    }

    /* 幽灵显示「当前会落在哪」，用户不用自己猜对齐。
       注意把 **当前这一屏的 grid** 传进去 —— 用 ctx 反查会拿到第 0 屏的网格。 */
    var r = st.node.getBoundingClientRect();
    var spot = snapTo(st.grid, st.ctx, r.left, r.top, st.cell.w, st.cell.h);
    var d = getDesktop();
    var ok = canPlace(d.pages, st.pi, st.cell, spot.x, spot.y);
    st.ghost.style.gridArea = spot.y + ' / ' + spot.x + ' / ' +
      (spot.y + st.cell.h) + ' / ' + (spot.x + st.cell.w);
    st.ghost.classList.toggle('is-bad', !ok);
    st.spot = spot;
    st.ok = ok;
  }

  function endCellDrag(p, ctx) {
    var st = dragState;
    if (!st) return;
    dragState = null;

    st.node.style.transform = '';
    st.node.style.zIndex = '';
    st.node.classList.remove('is-dragging');
    if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost);
    st.grid.classList.remove('is-drop-target');
    if (st.scaf) st.scaf.scroller.style.scrollBehavior = '';

    var spot = st.spot;
    if (!spot) return;

    /* 原地没动（也没换屏）：当作点了一下，不写存档 */
    if (st.pi === st.srcPi && spot.x === st.origin.x && spot.y === st.origin.y) return;

    var d = getDesktop();
    if (!canPlace(d.pages, st.pi, st.cell, spot.x, spot.y)) {
      ctx.toast('那儿放不下', 'warn');
      /* 跨屏失败要把节点挪回原来那一屏，否则它留在目标屏的 DOM 里、
         存档里却还在源屏 —— 下次渲染就凭空消失（或者更糟：重影）。 */
      if (st.pi !== st.srcPi && st.scaf && st.scaf.grids[st.srcPi]) {
        st.scaf.grids[st.srcPi].appendChild(st.node);
      }
      return;                    /* 不改存档，组件弹回原位（transform 已清） */
    }

    st.cell.x = spot.x;
    st.cell.y = spot.y;

    /* 跨屏：从源屏那一页摘掉，挂到目标屏那一页 —— 两处一起改，
       不能只改坐标（那样会在源屏留下一个同 id 的孤儿格）。 */
    if (st.pi !== st.srcPi) {
      var from = d.pages[st.srcPi] || [];
      var moved = null;
      for (var i = 0; i < from.length; i++) {
        if (from[i] && from[i].i === st.cell.i) { moved = from.splice(i, 1)[0]; break; }
      }
      if (!moved) moved = st.cell;
      moved.x = spot.x;
      moved.y = spot.y;
      d.pages[st.pi] = d.pages[st.pi] || [];
      d.pages[st.pi].push(moved);
      setDesktop(d);
      ctx.toast('挪到第 ' + (st.pi + 1) + ' 屏了', 'ok');
    } else {
      persistCell(ctx, st.pi, st.cell.i, spot.x, spot.y);
    }

    st.node.style.gridArea = spot.y + ' / ' + spot.x + ' / ' +
      (spot.y + st.cell.h) + ' / ' + (spot.x + st.cell.w);
  }

  /* ---------------------------- 桌面渲染 ---------------------------- */

  Sleepy.register('home', {
    title: '桌面',
    render: function (ctx) {
      var body = ctx.body;

      /* 重画前先把上一版留下的定时器收掉。
         有几个组件（时钟、世界时钟）自己 setInterval 走秒，元素被
         innerHTML 清掉之后定时器还活着 —— 每重画一次漏一个，
         切几次号就是一堆后台空转。 */
      var stale = body.querySelectorAll('.widget');
      for (var si = 0; si < stale.length; si++) {
        if (typeof stale[si].__cleanup === 'function') stale[si].__cleanup();
      }

      /* 重画会让编辑态里的节点全部换掉（dragState 指着的是旧节点），
         所以先退出编辑态，别留一个指向已销毁 DOM 的引用。 */
      exitEdit();

      body.innerHTML = '';

      var d = getDesktop();
      var scroller = h('div', 'dt-scroll');
      var dots = h('div', 'dt-dots');
      var dock = h('div', 'dt-dock');

      var pages = [];

      d.pages.forEach(function (cells, pi) {
        /* 第 0 屏（负一屏）单独挂一个类：那一屏只有一个「照片墙」大组件，
           它按行算出来的高度比这一屏可用高度矮一截，于是整屏是
           「上面挤满、下面空一片」（用户 2026-09-22 的原话）。
           样式里只给这一屏把网格**垂直居中**（见 .dt-screen.is-neg1）。 */
        var screen = h('div', 'dt-screen' + (pi === 0 ? ' is-neg1' : ''));
        var grid = h('div', 'dt-grid');

        /* 网格底纹：编辑态才显形。平时是一层极淡的点阵，
           用来暗示「这里是有格子的」——不留痕的话用户根本不知道
           组件能挪，也就不会去长按。 */
        var mesh = h('div', 'dt-mesh');
        for (var mi = 0; mi < COLS * ROWS; mi++) mesh.appendChild(h('span', 'dt-mesh-cell'));
        screen.appendChild(mesh);
        screen.appendChild(grid);

        cells.forEach(function (cell) {
          var node = renderCell(cell, ctx);
          bindCell(node, cell, pi, ctx);
          grid.appendChild(node);
        });

        /* 长按空白处也能进编辑态。
           组件之间的缝很窄，手指按不准；给整屏留一条后路，
           顺便让「点空白退出编辑」有地方落。 */
        screen.addEventListener('pointerdown', function (e) {
          if (e.target.closest && e.target.closest('.widget')) return;
          if (editing) return;
          var sx = e.clientX, sy = e.clientY;
          var t = setTimeout(function () {
            t = null;
            enterEdit(ctx);
          }, EDIT_MS);
          function stop() {
            if (t) { clearTimeout(t); t = null; }
            screen.removeEventListener('pointermove', away);
            screen.removeEventListener('pointerup', stop);
            screen.removeEventListener('pointercancel', stop);
          }
          function away(ev) {
            if (Math.abs(ev.clientX - sx) > MOVE_TOL || Math.abs(ev.clientY - sy) > MOVE_TOL) stop();
          }
          screen.addEventListener('pointermove', away);
          screen.addEventListener('pointerup', stop);
          /* 触摸横滑时浏览器接管滚动，派发的是 pointercancel（不是 pointermove），
             以前没监听它 → 撤销不执行 → 420ms 后照样进编辑态
             （用户：桌面一滑动就进编辑）。 */
          screen.addEventListener('pointercancel', stop);
        });

        /* 编辑态下点空白 = 退出。用 click 而不是 pointerdown，
           免得「按下想拖动」被当成退出。 */
        screen.addEventListener('click', function (e) {
          if (!editing) return;
          if (e.target.closest && e.target.closest('.widget')) return;
          exitEdit();
        });

        scroller.appendChild(screen);
        pages.push(screen);

        var dot = h('span', 'dt-dot');
        dot.setAttribute('data-i', String(pi));
        dots.appendChild(dot);
      });

      scroller.appendChild(h('div', 'dt-tail'));

      /* ---- 底部 Dock：全局常用入口 ----
         这里只放**跨 App 的全局**入口（聊天 / 世界书 / 设置）。
         早先放的是「聊天 / 名片夹 / 朋友圈 / 设置」，但名片夹和朋友圈
         其实是聊天 App 内部的构造（通讯录、动态），把它们提到系统级
         底栏会让「App」和「App 里的页面」混成一层。
         它们现在回到第 1 屏的网格里当普通组件，想放哪就放哪。

         注：dock 本身是常驻的，严格讲违反了「无固定栏位」那条总纲。
         保留是因为「回聊天」「开设置」是每个屏都要一步够到的动作，
         全塞进网格会让主屏变成通讯录。代价是它确实是个固定栏位 ——
         以后做真拖拽时应该把 dock 也变成可编辑的一排网格，这是已知欠账。 */
      [
        { app: 'chat-list', icon: ICONS.chat, name: '聊天' },
        { app: 'worldbook', icon: ICONS.worldbook, name: '世界书' },
        { app: 'settings', icon: ICONS.settings, name: '设置' }
      ].forEach(function (it) {
        var b = h('button', 'dt-dock-btn');
        b.type = 'button';
        b.setAttribute('data-app', it.app);   /* 桌面外观系统按它刷新 dock 显示 */
        var ov = (Sleepy.appearance && Sleepy.appearance.appOverride)
          ? Sleepy.appearance.appOverride(it.app) : null;
        var i = h('span', 'dt-dock-ic');
        if (ov && ov.iconMediaId && Sleepy.media) {
          var oimg = h('img', 'w-app-ic-img');
          Sleepy.media.url(ov.iconMediaId).then(function (u) { if (u) oimg.src = u; });
          i.appendChild(oimg);
        } else {
          i.innerHTML = it.icon;
        }
        b.appendChild(i);
        b.appendChild(h('span', 'dt-dock-name', (ov && ov.name) || it.name));
        b.addEventListener('click', function () { ctx.open(it.app); });
        dock.appendChild(b);
      });

      body.appendChild(scroller);
      body.appendChild(dots);
      body.appendChild(dock);

      /* ---- 翻页：横向 scroll-snap 交给浏览器，页码点自己跟 ----
         不用 transform 自己算位移：scroll-snap 在移动端有原生的
         惯性和回弹手感，自己写一遍只会更差。 */
      function syncDots() {
        var w = scroller.clientWidth || 1;
        var i = Math.round(scroller.scrollLeft / w);
        var all = dots.querySelectorAll('.dt-dot');
        for (var k = 0; k < all.length; k++) {
          all[k].classList.toggle('is-on', k === i);
        }
        /* 翻页时把上一屏里跑的定时器收掉，避免后台白转 */
        pages.forEach(function (pg, idx) {
          pg.classList.toggle('is-near', Math.abs(idx - i) <= 1);
        });
      }

      var raf = null;
      scroller.addEventListener('scroll', function () {
        if (raf) return;
        raf = global.requestAnimationFrame(function () {
          raf = null;
          syncDots();
        });
      });

      dots.addEventListener('click', function (e) {
        var t = e.target;
        if (!t.classList || !t.classList.contains('dt-dot')) return;
        var i = parseInt(t.getAttribute('data-i'), 10) || 0;
        scroller.scrollTo({ left: i * scroller.clientWidth, behavior: 'smooth' });
      });

      /* 首屏落在「主屏」（第 1 屏），负一屏往左滑才出来。

         ⚠️ 必须是**瞬移**，不能是动画（2026-09-22 用户报的坑）：
         .dt-scroll 上写着 scroll-behavior:smooth，那是给「点页码」用的；
         直接赋值 scrollLeft 也会被它接管 → 每次进桌面都从负一屏
         **平滑滑**到主屏，中间那几百毫秒里手指点在主屏图标的位置，
         落到的是还在屏幕上的**负一屏「＋加照片」格子**。
         用户原话：「每次点进去之后要加载一段时间才能点击主屏的图标，
         不然就会点击到负一屏加图片的地方」—— 说的就是这个动画窗口。
         所以程序性定位一律先把 scroll-behavior 压成 auto，落位再还原。 */
      function jumpTo(left) {
        var prev = scroller.style.scrollBehavior;
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollLeft = left;
        /* 读一次 scrollLeft 强制布局，确保 auto 这一帧就把最终位置定死 */
        void scroller.scrollLeft;
        scroller.style.scrollBehavior = prev || '';
      }

      function goHome() {
        if (scroller.clientWidth) {
          jumpTo(scroller.clientWidth);
        } else {
          setTimeout(goHome, 60);
        }
      }
      goHome();
      syncDots();

      /* 桌面外观系统：壁纸/大字落在 .page 上 —— render 完成后铺一次
        （启动时外观的 apply 跑得比这早，那时 .page 还不存在）。 */
      if (Sleepy.appearance && Sleepy.appearance.applyDesktop) {
        Sleepy.appearance.applyDesktop();
      }

      /* 切号后整屏重画。户型（base）不动，只有里面的数据和皮肤换掉 ——
         这正是总纲要的「原位替换」。 */
      ctx.repaint = function () {
        /* 重画会重建全部格子节点，编辑态里 dragState 指着的旧节点就悬空了 */
        exitEdit();

        var keep = scroller.scrollLeft;
        var cellIndex = Math.round(keep / (scroller.clientWidth || 1));
        var gridNodes = scroller.querySelectorAll('.dt-grid');
        var cells = getDesktop().pages;

        gridNodes.forEach(function (grid, pi) {
          var list = cells[pi] || [];
          /* 同 render：先把这一格里的定时器收干净再换内容 */
          var old = grid.querySelectorAll('.widget');
          for (var oi = 0; oi < old.length; oi++) {
            if (typeof old[oi].__cleanup === 'function') old[oi].__cleanup();
          }
          grid.innerHTML = '';
          list.forEach(function (cell) {
            var node = renderCell(cell, ctx);
            bindCell(node, cell, pi, ctx);
            grid.appendChild(node);
          });
        });
        if (scroller.clientWidth) jumpTo(cellIndex * scroller.clientWidth);
        syncDots();
      };
    },
    onShow: function (ctx) { if (ctx.repaint) ctx.repaint(); }
  });

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.desktop = {
    defaultDesktop: defaultDesktop,
    getDesktop: getDesktop,
    /* 布局写入唯一入口：活动岛有覆盖就写岛的覆盖，没有就写全局底座。
       组件商城 addWidget 也走它 —— 别直接 store.set('desktop')。 */
    setDesktop: setDesktop,
    skin: skin,
    ICONS: ICONS,
    icon: ic,
    SVG: SVG,

    /* 布局编辑。冒烟靠这几个口子核对「长按拖动」这条链路，
       也方便以后做一个「恢复默认布局」的按钮。 */
    LAYOUT_VERSION: LAYOUT_VERSION,
    /* 网格尺寸也导出去 —— 「组件商城」要按它算「放不放得下」，
       自己抄一份 4/6 的话，改了这里那边就悄悄错位。 */
    COLS: COLS,
    ROWS: ROWS,
    isEditing: isEditing,
    enterEdit: enterEdit,
    exitEdit: exitEdit,
    canPlace: canPlace,
    overlap: overlap
  };

  /* 首页是基底页，不走页面栈，它的 render 必须有人主动调一次
     （见 app.js 的 Sleepy.bootHome 注释）。
     注意点火时机：page-switch.js 会给 home 的 render 包一层，
     所以不能在这里调 —— 这里调时它还没加载，包装就落在渲染之后了。
     真正的点火放在最后一个脚本（page-chat-settings.js）的末尾。 */

})(window);
