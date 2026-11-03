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
    /* —— 2026-10-23 图标重绘批（用户逐个拍板，草图三轮定稿）——
       统一口径：全单色线稿（currentColor，深浅色自适应，桌面透底），
       Q 版感靠造型不靠点缀色。改过的：chat / worldbook / settings /
       memory（留痕，原来跟 gallery 撞图）/ appearance / widgetstore /
       新增 island（浮岛原来一直兜底用 chat 图标）。 */
    chat: ic('<path d="M4.2 10.2a5.4 4.9 0 0 1 5.4-4.9 5.4 4.9 0 0 1 5.4 4.9 5.4 4.9 0 0 1-5.4 4.9c-.7 0-1.4-.1-2-.3L4.6 16l.9-2.5a4.7 4.7 0 0 1-1.3-3.3z"/>' +
      '<circle cx="8.1" cy="10" r="1.05" fill="currentColor" stroke="none"/><circle cx="11.5" cy="10" r="1.05" fill="currentColor" stroke="none"/>' +
      '<path d="M16.6 8.3a4.6 4.2 0 0 1 3.2 4.1 4.6 4.2 0 0 1-1.2 2.8l.7 2-2.6-1.2c-.4.1-.9.2-1.4.2-.9 0-1.7-.2-2.4-.6"/>'),
    moments: ic('<rect x="3.5" y="7.5" width="12" height="10" rx="1.5"/><path d="M8 7.5V6A1.5 1.5 0 0 1 9.5 4.5h9A1.5 1.5 0 0 1 20 6v8a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M6.5 14.5l2.5-2.5 2 2 1.5-1.5 2 2"/>'),
    diary: ic('<rect x="5" y="4" width="14.5" height="16" rx="2"/><path d="M9 4v16"/><path d="M12.5 8.5H16M12.5 12h3.5"/>'),
    /* 留痕：心与箭（2026-10-23 重绘）—— 「被戳中的心留下痕迹」。
       原来是相框+山+圆点，跟 gallery（相册）几乎一模一样（设计规格指定换）。 */
    memory: ic('<path d="M12 17.2c-2.9-1.7-5.4-3.8-5.4-6.3 0-1.6 1.2-2.8 2.7-2.8 1.1 0 2.1.6 2.7 1.6.6-1 1.6-1.6 2.7-1.6 1.5 0 2.7 1.2 2.7 2.8 0 2.5-2.5 4.6-5.4 6.3z"/>' +
      '<path d="M3.4 18.6L20.6 4.2"/>' +
      '<path d="M18.6 3.6l2.2.4-.4 2.2"/>' +
      '<path d="M3.6 16.4l-.3 2.3 2.3-.3"/>'),
    favorites: ic('<path d="M12 4.6l2.3 4.7 5.2.75-3.75 3.66.89 5.19L12 16.45 7.36 18.9l.89-5.19L4.5 10.05l5.2-.75z"/>'),
    /* We（关系沉淀空间，第 3 屏 p3-fav 原收藏夹格）：两个圆 + 一条相连的线，
       表达「我和 TA」的关系纽带。风格跟其他线稿图标一致。 */
    we: ic('<circle cx="9" cy="9.5" r="3.1"/><circle cx="15" cy="14.5" r="3.1"/>' +
      '<path d="M11.5 11.5l2 2"/>' +
      '<path d="M6.5 9.5h.01M18.5 14.5h.01"/>'),
    me: ic('<circle cx="12" cy="8.4" r="3.5"/><path d="M5.5 19.2c0-3.1 2.9-5.3 6.5-5.3s6.5 2.2 6.5 5.3"/>'),
    idcard: ic('<rect x="4" y="5.5" width="16" height="13" rx="2"/><circle cx="9" cy="10.5" r="1.8"/><path d="M13.5 9h3.5M13.5 12h3.5M7 15.5h10"/>'),
    /* 世界书：平摊开的书 + 悬浮一颗星（2026-10-23 重绘，用户口径：
       「平着摊开的感觉，上面悬浮着星星」）。 */
    worldbook: ic('<path d="M12 8.2C10.4 6.6 8 5.9 4.4 6v11.6c3.6-.1 6 .6 7.6 2.2 1.6-1.6 4-2.3 7.6-2.2V6c-3.6-.1-6 .6-7.6 2.2z"/>' +
      '<path d="M12 8.2v11.6"/>' +
      '<path d="M6.6 9.4c1.6.1 2.9.4 4 1M6.6 12.4c1.6.1 2.9.4 4 1" stroke-width="1.2"/>' +
      '<path d="M17.4 9.4c-1.6.1-2.9.4-4 1M17.4 12.4c-1.6.1-2.9.4-4 1" stroke-width="1.2"/>' +
      '<path fill="currentColor" stroke="none" d="M12 1.4l.66 1.34 1.48.21-1.07 1.05.25 1.47L12 4.75l-1.32.72.25-1.47-1.07-1.05 1.48-.21z"/>'),
    /* ta（生活窗口，第 3 屏 p3-book 原世界书格）：一扇拱顶小窗 +
       窗里一颗心 —— 「看 ta 的生活」的那扇窗（2026-10-05 重画：
       旧版十字棂加星星看着像一扇门，需求：「这个图标换个好看点的吧」）。
       **必须有自己的条目**：下面 RENDER.app 的兜底是 ICONS.chat，
       不加就会跟聊天撞图标（2026-10-02 真机验收抓到）。 */
    ta: ic('<path d="M6.6 19.4V9.6a5.4 5.4 0 0 1 10.8 0v9.8"/>' +
      '<path d="M4.8 19.4h14.4"/>' +
      '<path d="M12 15.8c-1.7-1-3-2-3-3.4 0-1 .8-1.7 1.7-1.7.6 0 1 .3 1.3.8.3-.5.7-.8 1.3-.8.9 0 1.7.7 1.7 1.7 0 1.4-1.3 2.4-3 3.4z"/>'),
    /* 设置：真齿轮（2026-10-23 重绘）—— 三稿：用户给了 ⚙️ emoji 同款的
       参考图，定稿「圆齿实心」画法：齿 = 圆环上的 8 个圆帽虚点（粗描边
       + dasharray 0.1 5.35），和 r5.4 的身体圆环焊在一起，中间留孔。
       （一稿放射线像太阳；二稿方齿太重黑成一团。） */
    settings: ic('<circle cx="12" cy="12" r="6.9" fill="none" stroke-width="3.6" stroke-dasharray="0.1 5.35"/>' +
      '<circle cx="12" cy="12" r="5.4"/><circle cx="12" cy="12" r="1.9"/>'),
    heartbeat: ic('<path d="M3.6 12h3.2l2-4.4 2.8 9 2.4-6 1.6 3.2h4.8"/>'),
    gallery: ic('<rect x="3.5" y="5" width="17" height="14" rx="2.4"/><circle cx="9" cy="10" r="1.5"/><path d="M4.6 16.6l4.4-3.9 3.4 3 3-2.5 4 3.4"/>'),
    todo: ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 14.5l1.6 1.6L14 12.6"/>', 14),
    /* 外观：手持梳妆镜（2026-10-23 重绘）—— 椭圆镜面 + 握柄 + 镜台，
       镜面里一道高光弧。旧调色盘退役。组件商城：小抽屉（盒身 + 拉手），
       旧购物袋退役。浮岛：岛在云上（新增 island 条目 —— 原来桌面这格
       一直在兜底用 chat 图标）。 */
    appearance: ic('<ellipse cx="12" cy="9" rx="5.6" ry="5.9"/>' +
      '<path d="M12 14.9v2.2"/><path d="M9.4 19.6h5.2"/>' +
      '<path d="M9.5 7.4c.5-1 1.3-1.6 2.4-1.8"/>'),
    widgetstore: ic('<rect x="4.5" y="7" width="15" height="12.5" rx="2"/>' +
      '<path d="M4.5 12.2h15M10.4 9.6h3.2"/>'),
    island: ic('<path d="M6.8 12.4h10.4"/>' +
      '<path d="M7.6 12.4a4.4 3.1 0 0 1 8.8 0"/>' +
      '<path d="M12 9.3V6.4"/>' +
      '<path fill="currentColor" stroke="none" d="M12 6.4h3.1l-1.15 1 1.15 1h-3.1z"/>' +
      '<path d="M5.6 18.6a2.7 2.7 0 0 1 2.3-4.3 3.5 3.5 0 0 1 6.7-.5 2.8 2.8 0 0 1 2.9 4.8z"/>'),
    /* 第 3 屏的占位 App 用：贴纸、钱包。风格跟上面那批线稿图标一致 */
    stickers: ic('<circle cx="12" cy="12" r="8.4"/>' +
      '<path d="M12 7.6l1.42 2.88 3.18.46-2.3 2.24.54 3.16L12 14.85l-2.84 1.49.54-3.16-2.3-2.24 3.18-.46z"/>'),
    wallet: ic('<rect x="3.6" y="6.4" width="16.8" height="11.6" rx="2.4"/>' +
      '<path d="M16.4 10.6h4v3.2h-4a1.6 1.6 0 0 1 0-3.2z"/>'),
    /* 小岛指南（第 3 屏 x3,y4，版本 20 从「钱包」空壳改来的真入口）：
       一本翻开的书 + 里面一颗罗盘针 —— 「这本指南带你逛小岛」。
       形状跟上面那批线稿图标一致（24 格 / currentColor / 线宽 1.6）。 */
    guide: ic('<path d="M4.4 5.2c1.9-.9 3.7-.9 5.6 0v13.6c-1.9-.9-3.7-.9-5.6 0z"/>' +
      '<path d="M19.6 5.2c-1.9-.9-3.7-.9-5.6 0v13.6c1.9-.9 3.7-.9 5.6 0z"/>' +
      '<path d="M10 18.8h4"/>' +
      '<circle cx="12" cy="9.6" r="1.9"/>' +
      '<path d="M12 7.7v3.8M10.6 9.1l1.4 1.5 1.4-1.5"/>'),
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
    /* 群声（第 3 屏 x4,y3，版本 22 从「贴纸」空壳改来的真入口）：
       一只小喇叭 + 旁边两道声波 —— 「公共社区里众人的声音」。
       形状跟上面那批线稿图标一致（24 格 / currentColor / 线宽 1.6）。
       **必须有自己的条目**：RENDER.app 的兜底是 ICONS.chat，
       不加就会跟聊天撞图标（2026-10-02 真机验收抓到）。 */
    qunsheng: ic('<path d="M4.6 9.8v4.4a1.4 1.4 0 0 0 1.4 1.4h1.8l5.9 3.6V5.8L7.8 9.4H6a1.4 1.4 0 0 0-1.4 1.4z"/>' +
      '<path d="M17 9.9a3.1 3.1 0 0 1 0 4.2M19.3 7.9a6.1 6.1 0 0 1 0 8.2"/>'),
    /* 日历（第 3 屏，2026-09-19 接到该格）：一本翻开的台历 + 顶上两个挂环 */
    calendar: ic('<rect x="3.6" y="5.4" width="16.8" height="14.2" rx="2.2"/>' +
      '<path d="M3.6 10.2h16.8"/>' +
      '<path d="M8.6 3.4v3.6M15.4 3.4v3.6"/>' +
      '<path d="M7.4 13.4h2.2M12.4 13.4h4.2M7.4 16.4h2.2M12.4 16.4h2.4"/>'),
    /* 以身入局（第 3 屏 x4,y5，版本 23 从「组件商城」空壳改来的真入口）：
       一扇拱门里站着一个小人 —— 「踏进门里、亲身入局」的那道门。
       形状跟上面那批线稿图标一致（24 格 / currentColor / 线宽 1.7）。
       **必须有自己的条目**：RENDER.app 的兜底是 ICONS.chat，
       不加就会跟聊天撞图标。 */
    yishenruju: ic('<path d="M7 20.5V11a5 5 0 0 1 10 0v9.5"/>' +
      '<circle cx="12" cy="9" r="1.85"/>' +
      '<path d="M9.5 20.5v-4.6a2.5 2.5 0 0 1 5 0v4.6"/>'),
    /* 仓库（第 4 屏 p3-repo，版本 24 新真入口）：一只带提手的收纳箱，
       箱口一道横杠 —— 「把设定打包存取」的那只箱子。
       形状跟上面那批线稿一致（24 格 / currentColor / 线宽 1.6）。
       **必须有自己的条目**：RENDER.app 的兜底是 ICONS.chat。 */
    repo: ic('<rect x="4.4" y="8.6" width="15.2" height="11.4" rx="1.6"/>' +
      '<path d="M9.4 8.6V6.2A1.6 1.6 0 0 1 11 4.6h2a1.6 1.6 0 0 1 1.6 1.6v2.4"/>' +
      '<path d="M4.4 12.6h15.2M10 12.6v1.8h4v-1.8"/>')
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
     角色卡和情绪印章是设计规格指定拿掉的；时间和思念电量也是；
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
    换成「日历」（设计确认：日历是**单独的桌面 App**，不是查手机里那个；
    同一轮里查手机侧的日历 App 已经撤掉）。选它是因为设置本来就是
    桌面上重复度最高的一个 —— 主屏与第 2 屏各有一份（同版本 12 那条理由）。
    格子 id 仍沿用 p3-settings 不变 —— 那只是格子的名字。

     版本 4：名片夹 → 浮岛（`app: 'contacts'` 改成 `app: 'island'`，
     标签跟着改）。占位 id 故意沿用 `p1-idcard` 不变 —— 它只是这个格子的
     名字，改了会让老存档里的位置对不上，白白丢掉用户摆过的坐标。 */
  /* 版本 16（2026-09-19）：主屏第 6 行补上「帷境」通栏入口。
     帷境是**独立的一整个世界**（深夜蓝 / 月光纸本，见 style.css 里
     `[data-page^="wj-"]` 那一段），所以它不走 app 图标格 ——
     用新的 'wj' 渲染器做一条通栏：两片幕布 + 一行衬线字。

     版本 18（2026-10-02）：第 3 屏第 5 行「世界书」格换成「ta」（生活窗口 v1）。
     选它是因为世界书在这屏重复度最高 —— 主屏 p1-book 和底部 dock 各有一份，
     加上这格是三重入口。ta 首页只读展示当前角色的生活窗口
     （docs/勘察-ta首页-2026-10-02.md，页面在 page-ta.js，0 模型调用），
     它注册 'ta' 入口，桌面这格才点得开。
     格子 id 仍沿用 p3-book 不变 —— 那只是格子的名字（同版本 15 那条规矩）。

     版本 19（2026-10-05）：第 3 屏的「贴纸 / 钱包 / 组件商城」三个占位 App
     改成**空壳**（type 'blank'，新渲染器在 RENDER.blank）—— 需求：
     「这一屏的贴纸、钱包、组件商城的功能都有别的入口，统一改成图标为空，
     里面的内容为空，不要再跳转到别的页面去」。app 字段保留不删：
     一是冒烟断言还认桌面上的 app 名单，二是以后想接回来一行就够。
     We / 日历 / ta / 相册 / 外观这五个是真功能，不动。

     版本 20（2026-10-06）：第 3 屏 (x3,y4) 那格从「钱包」空壳改成
     **「小岛指南」真入口**（type 'app' / app 'guide' / 格子 id p3-guide）。
     设计规格指定：「第 3 屏留有空的 app，有占位没内容，可以直接用」——
     钱包那格从版本 19 起就只剩一个空玻璃壳（无图标、无内容、不跳转），
     正好拿来接《使用说明手册》（page-guide.js，按板块汇总全部功能）。
     「贴纸 / 组件商城」两格维持空壳不动。

     版本 21（2026-10-07）：第 3 屏 (x3,y5) 那格「外观」也改成**空壳**
     —— 它在主屏 p1-look 已经有一份，这屏这份是重复入口（需求）。
     LAYOUT_VERSION +1 强制迁移到新户型。

     版本 22（2026-10-07）：第 3 屏 (x4,y3) 那格「贴纸」空壳改成
     **「群声」真入口**（type 'app' / app 'qunsheng' / 格子 id p3-qunsheng）。
     群声 = 公共论坛 App（施工卡-群声-v1 Batch A，页面在 page-qunsheng.js，
     数据层 forum-core.js）。选贴纸这格是施工总单评估的默认项 + 用户确认：
     贴纸功能在聊天「我 → 表情包」和收藏馆里都有完整入口，桌面这格
     从版本 19 起就是空壳。贴纸的 stickers App 实现不删，只让出这一格。
     语义变了所以换格子 id（同版本 20 那条规矩），LAYOUT_VERSION +1。

    版本 23（2026-10-08）：第 3 屏 (x4,y5)「组件商城」空壳换成
    **「以身入局」真入口**（type 'app' / app 'yishenruju' / 格子 id p3-yishenruju）。
    组件商城在主屏 p1-store 已有完整入口，这格从版本 19 起就是空壳，正好接新 App。
    语义变了所以换格子 id（同版本 20/22 那条规矩）。「以身入局」首版是诚实占位页
    （page-yishenruju.js，点开显示「这一页还没贴好」），等定好玩法再填真实功能；
    不冒充完成。LAYOUT_VERSION +1。

    版本 25（2026-10-11）：仓库 App 改名「御膳房」—— p3-repo 格 label
    跟着改（id/app 不动），LAYOUT_VERSION +1 强制把老存档的 label 迁过来。 */
  var LAYOUT_VERSION = 25;

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
           2026-09-18 第七版：**双城时间整个撤掉**（需求：「这个双城时间
           可以直接删掉」），整屏让给那盏灯。

           第八版：**「正在播放」也撤掉**（需求：「这个可以去掉」）——
           它本来就是个占位组件，一个图标加一行字，并不真播东西。

           灯给到 4 列 × 4 行（374×374）—— 用户看到 2×3 那格之后的原话是
           「替换正在播放我会担心有点小，完全看不出字」。而且它放大态的暗场
           **只铺满自己的容器**，容器小，点开之后那张卡也大不了。

           第十二版（2026-09-18 晚）：第 5 行第一个格子「设置」换成
           「预设」（prompt-engine 的配置 app）—— 设置在主屏和第 3 屏
           各有一份，重复度最高，动它最不亏（需求：「随便替换一个就可以」）。
           格子 id 沿用 p2-settings 不变 —— 老存档的坐标别丢。

           ⚠️ 第 5 行下面那片空白是**翻屏唯一的手感区**：灯在桌面态也吃手势了
           （需求，见 style.css 里 .w-lamp-host canvas 那段），
           所以第 5 行那四个 App 和底下的空白是手指唯一能划走的地方，
           别把它们排满。 */
        [
          { i: 'p2-lamp', type: 'lamp', x: 1, y: 1, w: 4, h: 4, label: '挂件灯' },
          { i: 'p2-settings', type: 'app', app: 'presets', x: 1, y: 5, w: 1, h: 1, label: '预设' },
          /* 版本 14：这两个格子换 App 了（需求 2026-09-19）——
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
           2026-09-18 第九版：**日历整块撤掉**，换成音乐卡（需求：「这个
           直接被刚刚那个替换掉」）。待办从通栏挪到**中间右边**，
           并且不再是玻璃卡 —— 直接落在页面上（需求：「不要圆角框框，
           换成直接在页面上面的」）。

           音乐卡给 4 列 × 2 行（374×179）—— 参考图那张横版播放卡大约是
           2:1，这个格子正好 2.09:1，是最贴的形状。
           第九版当晚又调了一次：待办收到 **(1,3) 2×2**（需求：「todo 只占
           第三四行左边两列」），右半边和第五行补上一排**占位 App** ——
           原始需求「其他适当加占位app」。第六行故意留空，
           手机上那一行加上底栏，整个屏底才有透气的地方。 */
        [
          { i: 'p3-music', type: 'music', x: 1, y: 1, w: 4, h: 2, label: '音乐' },
          { i: 'p3-todo', type: 'todo', x: 1, y: 3, w: 2, h: 2, label: '待办' },
          /* 下面这些是**占位 App**（需求：「其他适当加占位app」）。
             优先挑**整个桌面都还没摆过**的：贴纸和钱包也一直没上过桌面
             （这两件是本轮新画的线稿图标）。
             ⚠️ 别顺手放「日记」—— 它和朋友圈都在 chat 里，冒烟里有一条断言守着，
             放回去会直接红。
             版本 17（2026-09-27）：**p3-fav 原收藏夹格换成 We**（关系沉淀空间）。
             收藏夹在聊天「我」里有完整入口（page-switch 早写了「收藏以后那个 we
             app 做」），We 首页也接了一个「去看看」跳到收藏 —— 桌面这格让给 We，
             收藏不丢功能。 */
          { i: 'p3-fav', type: 'app', app: 'we', x: 3, y: 3, w: 1, h: 1, label: 'We' },
          /* 版本 19（2026-10-05）：这三格改空壳（type 'blank'）——
             贴纸 / 钱包 / 组件商城都有别的入口，需求这一屏
             「图标为空、内容为空、不跳转」。app 字段留着：冒烟认名单，
             以后接回来把 type 改回 'app' 就行。 */
          { i: 'p3-qunsheng', type: 'app', app: 'qunsheng', x: 4, y: 3, w: 1, h: 1, label: '群声' },
          /* 版本 20（2026-10-06）：这一格从「钱包」空壳改成**小岛指南**真入口。
             设计规格指定「第 3 屏留有空的 app，有占位没内容，可以直接用」——
             钱包那格本来就没内容也没跳转（版本 19 起就是空壳），正好接上。
             app:'guide' 指向 page-guide.js 注册的《使用说明手册》。
             格子 id 改 p3-guide：语义变了，沿用 wallet 会让冒烟/存档对不上。 */
          { i: 'p3-guide', type: 'app', app: 'guide', x: 3, y: 4, w: 1, h: 1, label: '小岛指南' },
          /* 这里原本放的是「日记」，被冒烟断言挡下来了：
             「日记 / 朋友圈那两个我们都在 chat 里面做了，不需要单独的 app」——
             那是很早定下的一条，不能因为要凑格子就把它放回来。
             版本 15 换成**日历**（原来的「设置」挪走 —— 它在主屏和第 2 屏
             各有一份，是这里重复度最高的一个）。 */
          { i: 'p3-settings', type: 'app', app: 'calendar', x: 4, y: 4, w: 1, h: 1, label: '日历' },
          /* 版本 18：这格从「世界书」换成「ta」（生活窗口 v1）——
             世界书在主屏 p1-book 和底部 dock 各有一份，这格重复度最高。
             ⚠️ 格子 id 仍沿用 p3-book 不变 —— 改了老存档里的坐标就对不上。 */
          { i: 'p3-book', type: 'app', app: 'ta', x: 1, y: 5, w: 1, h: 1, label: 'ta' },
          { i: 'p3-gallery', type: 'app', app: 'gallery', x: 2, y: 5, w: 1, h: 1, label: '相册' },
          /* 版本 24（2026-10-10）：p3-look 外观空壳格（外观在主屏 p1-look 已有
             完整入口，2026-10-07 起是空壳）换成**仓库**真入口 —— 设计规格指定
             「第三屏有个外观 app 是空的，把仓库放那里」。
             语义变了换格子 id（同版本 20/22 规矩）：p3-look → p3-repo。
             仓库 = 设定打包分享（方案-设定仓库-v1；page-repo.js / repo-core.js / worker/）。 */
          { i: 'p3-repo', type: 'app', app: 'repo', x: 3, y: 5, w: 1, h: 1, label: '御膳房' },
          /* 版本 23（2026-10-08）：(x4,y5) 这格从「组件商城」空壳换成「以身入局」真入口
             （type 'app' / app 'yishenruju' / 格子 id p3-yishenruju）。组件商城在主屏 p1-store
             已有完整入口，这格从版本 19 起就是空壳。语义变了换格子 id（同版本 20/22 规矩）。 */
          { i: 'p3-yishenruju', type: 'app', app: 'yishenruju', x: 4, y: 5, w: 1, h: 1, label: '以身入局' },
        ]
      ]
    };
  }

  /* ---- 下架组件清洗（2026-10-30）----
     组件从商城下架（EXTRA_DEFS 摘掉）不等于桌上没了：老用户存档里
     还躺着旧格子，DOM 照画 —— 光摘目录只会造出「看得见删不掉」的
     观感（商城里已经没有这张卡了）。读档时把下架型号剥掉，
     全局底座和岛覆盖层都洗。retiredTypes 加新下架件就往里添一行。 */
  var RETIRED_TYPES = { starbottle: 1 };
  function stripRetired(d) {
    if (!d || !Array.isArray(d.pages)) return false;
    var hit = false;
    d.pages.forEach(function (list, pi) {
      var src = list || [];
      var keep = src.filter(function (c) { return !(c && RETIRED_TYPES[c.type]); });
      if (keep.length !== src.length) { d.pages[pi] = keep; hit = true; }
    });
    return hit;
  }
  /* 回收站里的下架件记录也剥（2026-10-30 体检实锤）：留着只会
     「装回来 toast 说成功、下次读档又被剥掉」——白开心一场。 */
  function stripRetiredRemoved() {
    var list = store.get('desktopRemoved') || [];
    var keep = list.filter(function (r) { return !(r && RETIRED_TYPES[r.type]); });
    if (keep.length !== list.length) store.set('desktopRemoved', keep);
  }

  function getDesktop() {
    var d = store.get('desktop');

    /* 没有存档 / 结构不对：落一份默认的 */
    if (!d || !Array.isArray(d.pages) || d.pages.length !== PAGES) {
      d = defaultDesktop();
      store.set('desktop', d);
      stripRetiredRemoved();
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
    /* 下架件清洗：全局底座剥完落盘（岛覆盖层在 withIslandOverlay 里洗）
       + 回收站里的下架件记录一并剥 */
    if (stripRetired(d)) store.set('desktop', d);
    stripRetiredRemoved();
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
    /* 下架件清洗：覆盖层剥完也落盘（否则那座岛上的旧格子一直阴魂不散） */
    if (stripRetired(ov)) {
      base.islands[sbId] = ov;
      store.set('desktop', base);
    }
    /* 存量自愈（v298）：v297 的两道防线只管**新写入**，老存档里已经
     躺着的遗留要在这里修 —— ①覆盖层内嵌 islands（岛套岛存量）
     ②覆盖层与全局底座共用同一个 w-id（倒计时/拍立得配置跨岛共享）。
     都是读档一次性修，修完落盘。 */
    var healed = false;
    if (ov.islands) { delete ov.islands; healed = true; }
    if (overlayClashesGlobal(base, ov)) {
      ov = remapForOverlay(ov);
      healed = true;
    }
    if (healed) {
      base.islands[sbId] = ov;
      store.set('desktop', base);
    }
    return ov;
  }

  /* 覆盖层里有没有非骨架格子跟全局底座撞同一个 id
     （撞了 = 这份 widgetCfg 两座岛共享着，得 remap） */
  function overlayClashesGlobal(base, ov) {
    var skeleton = {};
    defaultDesktop().pages.forEach(function (cells) {
      (cells || []).forEach(function (c) { if (c && c.i) skeleton[c.i] = 1; });
    });
    var globalIds = {};
    (base.pages || []).forEach(function (cells) {
      (cells || []).forEach(function (c) {
        if (c && c.i && !skeleton[c.i]) globalIds[c.i] = 1;
      });
    });
    var clash = false;
    ov.pages.forEach(function (cells) {
      (cells || []).forEach(function (c) {
        if (c && c.i && globalIds[c.i]) clash = true;
      });
    });
    return clash;
  }

  function setDesktop(d) {
    var sbId = activeIslandId();
    if (!sbId) { store.set('desktop', d); return; }
    var base = store.get('desktop');
    if (!base || !Array.isArray(base.pages) || base.pages.length !== PAGES) {
      base = defaultDesktop();
    }
    base.islands = base.islands || {};
    /* 岛套岛防线（2026-10-30 体检实锤）：无岛时 getDesktop() 返回的 base
       自带别的岛的 islands，整份复制进本岛覆盖层会把它们一起裹进来 ——
       数据膨胀 + 幽灵覆盖。岛的布局就是几屏格子，永远不该再含 islands。 */
    function sanitize(d) {
      if (!d || !d.islands) return d;
      var cp = JSON.parse(JSON.stringify(d));
      delete cp.islands;
      return cp;
    }
    var ov = base.islands[sbId];
    var firstCustom = !ov || !Array.isArray(ov.pages) || ov.pages.length !== PAGES;
    if (firstCustom) {
      /* 首次自定义：整份复制 + 非骨架格子重新发 id、widgetCfg 条目跟着迁
         （体检实锤：同一份全局布局复制进多座岛后 w-id 相同，
         倒计时日子/拍立得照片跨岛共享一份，A 岛改 B 岛跟着变）。 */
      base.islands[sbId] = remapForOverlay(d);
    } else if (d && d.islands) {
      base.islands[sbId] = sanitize(d);
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

    /* 第三步（2026-10-30 体检实锤）：用户自装的组件（商城摆出去、
       id 是 newId('w') 生成的）不在骨架里 —— 以前走到这里直接蒸发，
       注释明明写着「保住自定义」。修：原位搬回；撞了/放不下就找空位；
       真没地方就记进回收站，绝不静默丢。 */
    var kept = {};
    fresh.pages.forEach(function (cells) {
      cells.forEach(function (c) { if (c && c.i) kept[c.i] = 1; });
    });
    var orphans = [];
    (old.pages || []).forEach(function (cells) {
      (cells || []).forEach(function (c) {
        if (!c || !c.i || kept[c.i]) return;
        if (c.type === 'blank') return;    /* 空壳不值得占格子 */
        kept[c.i] = 1;
        orphans.push(c);
      });
    });
    orphans.forEach(function (c) {
      var w = Math.min(c.w || 1, COLS), hh = Math.min(c.h || 1, ROWS);
      var spot = null;
      /* 原位：重叠只查**本屏**（照片墙在第 0 屏占满 4×6，跨屏查的话
         它会跟任何坐标都「撞」，孤儿永远落不了位 —— 第一版就栽在这） */
      var origPi = -1;
      for (var pi = 0; pi < (old.pages || []).length; pi++) {
        if ((old.pages[pi] || []).some(function (o) { return o && o.i === c.i; })) { origPi = pi; break; }
      }
      if (origPi >= 0 && c.x >= 1 && c.y >= 1 &&
          c.x + w - 1 <= COLS && c.y + hh - 1 <= ROWS &&
          !pageHits(fresh.pages[origPi], { x: c.x, y: c.y, w: w, h: hh })) {
        spot = { pi: origPi, x: c.x, y: c.y };
      } else {
        spot = findFreeSpot(fresh.pages, w, hh);
      }
      if (spot) {
        while (fresh.pages.length <= spot.pi) fresh.pages.push([]);
        fresh.pages[spot.pi].push({
          i: c.i, type: c.type, app: c.app || '', label: c.label || '',
          tplId: c.tplId,
          x: spot.x, y: spot.y, w: w, h: hh
        });
      } else {
        rememberRemoved(c, null);
      }
    });

    fresh.version = toVersion;
    return fresh;
  }

  /* 单屏内是否有人跟 probe 重叠 */
  function pageHits(pageCells, probe) {
    var hit = false;
    (pageCells || []).forEach(function (c) { if (overlap(probe, c)) hit = true; });
    return hit;
  }

  /* 岛覆盖首次落底：非骨架格子（商城装出去的 w-id 格）重新发 id，
     widgetCfg 条目迁到新 id 下 —— 骨架格（p1-head 这些）每岛同 id 是
     有意的（渲染器按 id 找皮肤），不动。 */
  function remapForOverlay(d) {
    var cp = JSON.parse(JSON.stringify(d));
    delete cp.islands;
    var skeleton = {};
    defaultDesktop().pages.forEach(function (cells) {
      (cells || []).forEach(function (c) { if (c && c.i) skeleton[c.i] = 1; });
    });
    var cfg = store.get('widgetCfg') || {};
    var moved = null;
    cp.pages.forEach(function (cells) {
      (cells || []).forEach(function (c) {
        if (!c || !c.i || skeleton[c.i]) return;
        var nid = core.newId('w');
        if (cfg[c.i]) {
          if (!moved) moved = {};
          moved[nid] = cfg[c.i];
        }
        c.i = nid;
      });
    });
    if (moved) store.set('widgetCfg', Object.assign({}, cfg, moved));
    return cp;
  }

  /* 找第一块放得下的空位（跨屏找；widgetstore 的 findSpot 同思路，
     这里不能反过来依赖它 —— 脚本加载顺序 page-desktop 在前）。
     重叠只跟**当前扫到的这一屏**比，别拿全桌面的格子来撞。 */
  function findFreeSpot(pages, w, h) {
    for (var pi = 0; pi < pages.length; pi++) {
      for (var y = 1; y + h - 1 <= ROWS; y++) {
        for (var x = 1; x + w - 1 <= COLS; x++) {
          if (!pageHits(pages[pi], { x: x, y: y, w: w, h: h })) return { pi: pi, x: x, y: y };
        }
      }
    }
    return null;
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
     中间嵌一颗开关 —— 原始需求「有点像麦克风一样」。

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
     原始需求「现在的这些画其实会看起来很廉价」，以后由角色往里写。
     ★ 配色 2026-10-06 定稿：core 的 PALETTE 已整表换成用户选的 5 个
     柔和浅色（薄荷汽水/晨雾蓝/西柚苏打/燕麦暖白/雾灰香芋，见
     vendor/lamp/acrylic-lamp.html），tone 键名兼容不变，这里 5 张空板
     正好把 5 个色都摊开循环。旧的「换 ink/sky/aqua 压饱和」那条是
     针对旧高饱和粉彩的救火，色板换掉后已作废。
     ⚠️ 传几张都没用：36 个挂点是核心的 CFG.rings 写死的（`defs[n % defs.length]`）。
     2026-10-06 起这 5 张空板是**垫底的补数板** —— 上面的 lampCards() 会把
     留言卡（store lampNotes）排在它们前面，留言先挑好挂点。 */
  var LAMP_CARDS = [
    { text: '', art: 'text', tone: 'sky' },
    { text: '', art: 'text', tone: 'mint' },
    { text: '', art: 'text', tone: 'coral' },
    { text: '', art: 'text', tone: 'cream' },
    { text: '', art: 'text', tone: 'lilac' }
  ];

  /* 灯光。四档切换入口在组件商城的灯设置面板（批2，写 store 'lampLight'，
     Sleepy.lampCtl.lightSet）。默认 day 是实测结论 —— 内置四档在浅色底上：
       day    浅奶油磨砂，最贴白色 UI        ← 选它
       warm   琥珀金，偏重但成立
       candle 橙得过头
       moon   卡片发脏橄榄褐，最差（它本来就是为深底做的） */
  var LAMP_DEFAULT_LIGHT = 'day';

  /* ---------- 灯上的留言（2026-10-06） ----------
     数据在 store 'lampNotes'，按岛隔离（写入口 core.tagScope 盖章、
     读取 core.scoped 过滤、cleanupSandbox 删房跟着清 —— 三处配套都登记了）。
     三个写入入口都汇聚到 Sleepy.lampNotes.add()：
       · page-proactive.js  角色主动消息发送成功后自动留一张（src:'proactive'）
       · page-chat.js       私聊长按菜单「留在灯上」（src:'chat'）
       · page-group.js      群聊长按别人的气泡直接留（src:'group'，带 char 署名）
     灯实例是常驻的，add() 落库后直接 setCards 热刷新；
     灯还没创建也不要紧 —— boot() 建灯时 cards 从 store 现读。
     ⚠️ 卡上的文字是 canvas 画的，换行/空白先压平、上限 40 字（超出截断加省略号），
        别把超长消息整段甩给 paintCard（它会硬塞满整张卡）。 */
  var LAMP_NOTES_KEY = 'lampNotes';
  var LAMP_NOTES_MAX = 60;
  var LAMP_NOTE_TONES = ['sky', 'mint', 'coral', 'cream', 'lilac'];

  function lampNoteList() {
    var all = store.get(LAMP_NOTES_KEY) || [];
    return core.scoped ? core.scoped(all) : all;
  }

  /* 留言卡排在前面（先到先挑好挂点），空板垫在后头补数。
     __note 是给落款浮层用的元数据 —— core 的 setCards 原样存 def，
     onFocus 回调里能原样拿回来。
     ★ 2026-10-12 同句重复悬挂修复（用户报：「选了一句话，上中下三层
     各自有个卡片带着同一句」）：
       核心按 defs[n % defs.length] 把 def 数组往 **36 个挂点**
       （CFG.rings 四层 count 6+8+10+12）上轮着挂 —— 数组不补齐时，
       1 条留言 + 5 张空板 = 6 个 def，同一条留言会被挂 36/6=6 次，
       四层里每层都能看见它。补齐到 36 之后 % 运算恒等，
       每条留言只占一个挂点，空板循环填剩下的（空板没有文字，
       重复不重复看不出来）。
     ⚠️ 36 = 核心 CFG.rings 各层 count 之和 —— 改核心挂点数必须同步这里，
       冒烟里有对应断言（同 SW 缓存基准，是刻意的人工确认点）。 */
  var LAMP_SLOTS = 36;

  function lampCards() {
    var cards = [];
    var notes = lampNoteList();
    /* 超员（LAMP_NOTES_MAX=60 > 36）时只挂得下 36 条：**新留的先把旧的
       挤下灯**（store 里仍在，商城灯面板可删）—— 否则第 37 条起永远
       上不了灯，用户留了却看不见。 */
    var shown = notes.length > LAMP_SLOTS
      ? notes.slice(notes.length - LAMP_SLOTS) : notes;
    for (var i = 0; i < shown.length; i++) {
      var n = shown[i];
      cards.push({
        text: n.text + '\n——' + (n.by || '我'),
        art: 'text',
        tone: n.tone || 'cream',
        __note: { id: n.id, by: n.by || '我', ts: n.ts }
      });
    }
    for (var j = 0; cards.length < LAMP_SLOTS; j++) {
      cards.push(LAMP_CARDS[j % LAMP_CARDS.length]);
    }
    return cards;
  }

  /* 灯牌字体：优先灯牌专属的 lampFontUrl（商城灯面板里填，family 用
     'SleepyLampFont'，和外观的 'SleepyCustomFont' 互不抢 @font-face）；
     没填就回落外观 fontUrl（老行为）。两处 style id 不同，双方互斥。 */
  function ensureLampFontFace() {
    var lampUrl = store.get('lampFontUrl') || '';
    if (lampUrl) {
      var old = document.getElementById('lk-lamp-font');
      if (!old) {
        var st = document.createElement('style');
        st.id = 'lk-lamp-font';
        st.textContent = "@font-face{font-family:'SleepyLampFont';src:url('" +
          String(lampUrl).replace(/'/g, '%27') + "');font-display:swap;}";
        document.head.appendChild(st);
      }
      return 'SleepyLampFont';
    }
    var a = store.get('appearance') || {};
    if (!a.fontUrl) return '';
    if (!document.getElementById('lk-custom-font')) {
      var st2 = document.createElement('style');
      st2.id = 'lk-custom-font';
      st2.textContent = "@font-face{font-family:'SleepyCustomFont';src:url('" +
        String(a.fontUrl).replace(/'/g, '%27') + "');font-display:swap;}";
      document.head.appendChild(st2);
    }
    return 'SleepyCustomFont';
  }

  var lampNotesApi = {
    add: function (note) {
      if (!note || !note.text) return null;
      var text = String(note.text).replace(/\s+/g, ' ').trim();
      if (!text) return null;
      /* ★ 2026-10-12：'||' 是聊天气泡的分段协议（prompt-engine
         splitBubbles）—— 任何入口把带分隔符的整串送进来（长按整条 /
         [灯:] 标签里写了 ||），卡面上都会读出「句一||句二」这种分割符。
         换成换行：一句话一行，paintCard 本来就按 \n 分行，正好这么读。
         放在压空白之后 —— 压空白会把 \n 也抹掉，顺序不能反。 */
      text = text.split('||').join('\n');
      if (text.length > 40) text = text.slice(0, 39) + '…';
      var list = store.get(LAMP_NOTES_KEY) || [];
      var rec = core.tagScope({
        id: core.newId('ln'),
        text: text,
        by: String(note.by || '我').slice(0, 12),
        tone: LAMP_NOTE_TONES[list.length % LAMP_NOTE_TONES.length],
        ts: note.ts || Date.now(),
        src: note.src || 'chat'
      });
      list.push(rec);
      if (list.length > LAMP_NOTES_MAX) list = list.slice(list.length - LAMP_NOTES_MAX);
      store.set(LAMP_NOTES_KEY, list);
      if (lampState.inst) lampState.inst.setCards(lampCards());
      return rec;
    },
    /* 留言管理（商城灯面板批2）：按 id 删一张，落库 + 热刷新。 */
    remove: function (id) {
      var list = store.get(LAMP_NOTES_KEY) || [];
      var out = list.filter(function (r) { return r && r.id !== id; });
      if (out.length === list.length) return list.length;
      store.set(LAMP_NOTES_KEY, out);
      if (lampState.inst) lampState.inst.setCards(lampCards());
      return out.length;
    },
    list: lampNoteList
  };
  Sleepy.lampNotes = lampNotesApi;

  /* 灯的设置控制面（商城灯面板批2 的唯一写入口）：
     · lightSet 存档 + 灯活着就热切（publish 里的「重画重读存档」仍兜底）
     · fontSet 存档 + 重注入 @font-face + 灯活着就 setFont 重画
       （清空 URL 时摘掉专属 style，回落外观字体/楷体栈） */
  function lampLightSet(name) {
    store.set('lampLight', name);
    if (lampState.inst && lampState.inst.setLight) {
      lampState.inst.setLight(name);
      lampState.light = name;
    }
  }
  function lampFontSet(url) {
    var v = String(url || '').trim();
    store.set('lampFontUrl', v);
    var st = document.getElementById('lk-lamp-font');
    if (st && st.parentNode) st.parentNode.removeChild(st);
    if (!v) {
      var fam2 = ensureLampFontFace();
      if (lampState.inst) lampState.inst.setFont(fam2);
      return fam2;
    }
    var fam = ensureLampFontFace();
    var apply = function () {
      if (lampState.inst && document.fonts) {
        document.fonts.load("16px '" + fam + "'").then(function () {
          if (lampState.inst) lampState.inst.setFont(fam);
        })['catch'](function () { /* 字体失败就留在当前栈 */ });
      }
    };
    apply();
    return fam;
  }
  Sleepy.lampCtl = {
    lightGet: lampLight,
    lightSet: lampLightSet,
    fontGet: function () { return store.get('lampFontUrl') || ''; },
    fontSet: lampFontSet,
    notes: lampNotesApi
  };

  /* 放大态的落款浮层。rec.def.__note 是留灯时塞进卡片定义的元数据；
     空板没有 __note，浮层不出现（灯牌上「谁在什么时候留的话」只属于留言卡）。 */
  function showLampSign(rec) {
    var box = lampState.box;
    if (!box) return;
    var el = box.querySelector('.w-lamp-sign');
    if (!el) return;
    var meta = rec && rec.def && rec.def.__note;
    if (!meta) { el.classList.remove('is-on'); return; }
    var d = new Date(meta.ts || Date.now());
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    el.textContent = '—— ' + meta.by + ' · ' + (d.getMonth() + 1) + '月' +
      d.getDate() + '日 ' + hh + ':' + mm;
    el.classList.add('is-on');
  }


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
      /* 状态签名已下线（2026-09-29）：第二行恒为「在线」；
         角色卡这块展示等组件商城重做时再议。 */
      status: c ? '在线' : (roster ? '从桌面下拉或切号器选一位' : '去浮岛开一间房'),
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
       需求：「桌面进入编辑模式后，所有的组件都加上一个小叉叉，
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
    /* 自制组件的模板链接必须跟走（2026-10-30 体检实锤：漏了它，
       装回来永远「模板不见了」——模板明明还在）。 */
    if (cell.tplId) rec.tplId = cell.tplId;
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

    /* 幽灵格兜底（2026-10-30 用户实锤「点×没办法删掉」）：
       数据里找不到这格，但屏幕上还看着它 —— 桌面 DOM 比存档活得久
       （首页是基底页不走页面栈，从商城「拿下来」之后回桌面**不重画**，
       之前删掉的那件就一直阴魂不散；这时再点叉叉，数据里根本没它，
       上面的循环空手而归，什么都不发生）。重画一遍让 DOM 对齐数据，
       幽灵自然消失，别静默装死。 */
    if (ctx.repaint) ctx.repaint();
    enterEdit(ctx, true);
    ctx.toast('已经不在桌上了 · 桌面刷新好了', 'ok');
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

    /* ---------------- 占位空壳（第 3 屏贴纸 / 钱包 / 组件商城） ----------------
       版本 19（2026-10-05）：需求这三格「图标为空、内容为空、
       不要再跳转到别的页面去」—— 功能都有别的入口，这里只留一个
       空玻璃壳 + 文字标签占住格子。用 div 不用 button：不可聚焦、
       不吃点击；编辑态的小叉叉是 renderCell 统一挂的，不受影响。 */
    blank: function (cell, ctx) {
      var box = h('div', 'widget w-app w-blank');
      box.appendChild(h('span', 'w-app-ic'));
      box.appendChild(h('span', 'w-app-name', cell.label || ''));
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

    /* ---------------- 首页日期头（主屏最上面那块） ----------------
       2026-09-17 第四轮。用户给的参考版式：一行小字抬头、一个很大的
       日期数字、一行日期，右侧一根绳子挂下来一个小玻璃坠子。

       第五轮改动（需求：「我要字体直接呈现在上面，而不是加框」）：
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
         文案是照着参考图的骨架重写的（需求：「这个只是一个示例，
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

       放大态要浮到所有层之上（需求）。做法是给 box 挂 .is-focus，
       由 CSS 把它变成 position:fixed; inset:0; z-index 压过 dock ——
       `.page` 上有 transform，所以 fixed 的包含块是**整个手机屏**而不是
       浏览器窗口，范围正好。 */
    lamp: function (cell, ctx) {
      /* 上一帧的 box 若还在放大态（被挪到 .page），重画前先收掉 ——
         重画只清 grid，挪出去的旧节点没人管，会一直压在屏上
         （需求 2026-09-21：切过外观后模型变大、显示不全）。 */
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
      /* 落款浮层（放大态才显示，样式见 style.css .w-lamp-sign）。
         内容由 showLampSign 在 onFocus 时填。 */
      var sign = h('div', 'w-lamp-sign');
      box.appendChild(sign);
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
        /* 核心留了两个回调槽：放大态翻 class + 挪节点 + 落款浮层。
           rec 是被拿到眼前的那张卡的原始定义（留言卡带 __note 元数据）。 */
        el.onFocus = function (rec) { applyLampFocus(rec); showLampSign(rec); };
        el.onBlur = function () { applyLampFocus(null); showLampSign(null); };
        applyLampFocus();
      }

      if (lampState.inst) {
        publish(lampState.inst);
        /* 换屏/换格子后容器尺寸变了，让核心重新取景。
           但要等 box 真的挂进 DOM 再量 —— renderCell 返回后调用方才 append，
           这时 host.clientWidth 还是 0，直接 resize 会让核心回落到 window
           尺寸，canvas 被撑成整窗、看着「变大又下移」
           （需求 2026-09-21：切过外观后 3D 模型变大、显示不全）。 */
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
          /* 灯牌字体：外观设置里填了字体 URL 就把 'SleepyCustomFont'
             插进卡面字体栈；webfont 晚就绪的话，加载完再 setFont 重画一次。 */
          var lampFont = ensureLampFontFace();
          var el0 = create(host, {
            cards: lampCards(),
            frame: 'champagne',
            autoSpin: 0.06,
            dust: true,
            font: lampFont || undefined,
            /* 手机屏 dpr 动辄 3，画 3 倍像素肉眼看不出、卡顿却很实在。
               核心自己也封到 2，这里再往下压一档。 */
            dpr: window.devicePixelRatio > 1.5 ? 1.5 : 1
          });
          publish(el0);
          if (lampFont && document.fonts && document.fonts.load) {
            document.fonts.load("16px '" + lampFont + "'").then(function () {
              /* 字体真就绪了才重画；期间灯被销毁/重建就别管旧实例了 */
              if (lampState.inst === el0) el0.setFont(lampFont);
            })['catch'](function () { /* 字体加载失败就用楷体栈，不拦灯 */ });
          }
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

    /* ---------------- 批3 · 简单砖组 + 拍立得（2026-10-06 商城批） ----------------
       四个商城上架件（不在默认户型，目录在 page-widgetstore 的 EXTRA_DEFS）。
       共用一条配置约定：per-cell 配置存 store 'widgetCfg'（键 = cell.i），
       点组件弹表单/选图面板；删除走通用 removeCell，无专属清理
       （widgetCfg 是全局小键，孤儿条目跟 desktopRemoved 一个量级，无害）。
       材质全走 --tk-* 玻璃变量 —— 施工卡定稿第 3 条：小方禁止写死底色。 */

    countdown: function (cell, ctx) {
      var box = h('div', 'widget w-countdown');
      function daysLeft(target) {
        var t = new Date(target + 'T00:00:00');
        if (isNaN(t.getTime())) return null;
        var now = new Date();
        var base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return Math.round((t.getTime() - base.getTime()) / 86400000);
      }
      function paint() {
        var cfg = widgetCfgOf(cell.i) || {};
        box.innerHTML = '';
        if (!cfg.target) {
          box.appendChild(h('div', 'w-countdown-empty', '点我设个日子'));
          return;
        }
        var n = daysLeft(cfg.target);
        var big = n === null ? '—'
          : (n > 0 ? String(n) : (n === 0 ? '就是今天' : '过了 ' + Math.abs(n) + ' 天'));
        box.appendChild(h('div', 'w-countdown-num', big));
        box.appendChild(h('div', 'w-countdown-label', cfg.label || cfg.target));
      }
      paint();
      box.addEventListener('click', function () {
        var cfg = widgetCfgOf(cell.i) || {};
        ui.prompt({
          title: '倒数日',
          fields: [
            { key: 'label', label: '这事叫什么', value: cfg.label || '', placeholder: '见面 / 生日…' },
            { key: 'target', label: '哪一天', value: cfg.target || '', placeholder: '2027-01-01' }
          ]
        }).then(function (r) {
          if (!r) return;
          var target = String(r.target || '').trim();
          if (target && isNaN(new Date(target + 'T00:00:00'))) {
            ctx.toast('日期没认出来，要 2027-01-01 这种', 'warn');
            return;
          }
          widgetCfgSet(cell.i, { label: String(r.label || '').trim().slice(0, 8), target: target });
          paint();
        });
      });
      return box;
    },

    weatherbrick: function (cell, ctx) {
      var box = h('div', 'widget w-weatherbrick');
      function paint() {
        box.innerHTML = '';
        var w = null;
        try { w = store.get('rwWeatherLast') || null; } catch (e) { w = null; }
        if (!w || !w.temp) {
          box.appendChild(h('div', 'w-weatherbrick-empty', '天气'));
          box.appendChild(h('div', 'w-weatherbrick-hint', '去设置开天气感知'));
          return;
        }
        box.appendChild(h('div', 'w-weatherbrick-temp', w.temp + '°'));
        box.appendChild(h('div', 'w-weatherbrick-desc', (w.desc || '—') + ' · ' + (w.city || '')));
      }
      paint();
      /* 渲染时顺手 poke —— rwPoke 内部有 30 分钟 TTL，缓存热着不会真打网络；
         拉到了就重画一次（4s 超时兜底，绝不挂住桌面）。 */
      if (Sleepy.core && Sleepy.core.realworld && Sleepy.core.realworld.poke) {
        Sleepy.core.realworld.poke().then(function () { paint(); });
      }
      box.addEventListener('click', function () {
        var w = null;
        try { w = store.get('rwWeatherLast') || null; } catch (e) {}
        if (w && w.temp) {
          ctx.toast((w.city || '') + ' ' + w.desc + ' ' + w.temp + '°C · 体感 ' + w.feels + '°C · 湿度 ' + w.hum + '%');
        } else {
          ctx.toast('先去 设置 → 天气感知 打开（要 key 和城市）', 'warn');
        }
      });
      return box;
    },

    dateclock: function (cell, ctx) {
      var box = h('div', 'widget w-dateclock');
      var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      function paint() {
        var d = new Date();
        box.innerHTML = '';
        box.appendChild(h('div', 'w-dateclock-date', (d.getMonth() + 1) + '月' + d.getDate() + '日'));
        box.appendChild(h('div', 'w-dateclock-time', bigTime(d)));
        box.appendChild(h('div', 'w-dateclock-wd', WD[d.getDay()]));
      }
      paint();
      /* 时钟的 interval 必须挂 __cleanup（music 组件踩过的坑：重画一次多一个定时器） */
      var timer = setInterval(paint, 15000);
      box.__cleanup = function () { clearInterval(timer); };
      return box;
    },

    polaroid: function (cell, ctx) {
      var box = h('div', 'widget w-polaroid');
      var MAX_PICK = 4;
      function selIds() {
        var cfg = widgetCfgOf(cell.i) || {};
        return Array.isArray(cfg.photoIds) ? cfg.photoIds : [];
      }
      function paint() {
        box.innerHTML = '';
        var ids = selIds();
        if (!ids.length) {
          box.appendChild(h('div', 'w-polaroid-empty', '点我贴照片'));
          return;
        }
        var all = wallPhotos();
        var picked = ids.map(function (id) {
          for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
          return null;
        }).filter(Boolean).slice(0, MAX_PICK);
        picked.forEach(function (p, i) {
          var f = h('div', 'w-polaroid-item ' + (i % 2 ? 'is-tilt-r' : 'is-tilt-l'));
          var img = h('div', 'w-polaroid-img');
          f.appendChild(img);
          f.appendChild(h('em', null, p.caption || shortDate(p.at)));
          box.appendChild(f);
          if (Sleepy.photos && Sleepy.photos.srcOf) {
            Sleepy.photos.srcOf(p).then(function (src) {
              if (src) img.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
            });
          }
        });
      }
      paint();
      box.addEventListener('click', function () {
        var all = wallPhotos();
        if (!all.length) { ctx.toast('相册还是空的，先去相册加几张', 'warn'); return; }
        var picked = {};
        selIds().forEach(function (id) { picked[id] = 1; });
        var pop = ui.anchorPopover(box, { className: 'ws-polaroid-pop', width: '252px' });
        pop.el.appendChild(h('div', 'ws-polaroid-title', '点选要贴上墙的照片（最多 ' + MAX_PICK + ' 张）'));
        var grid = h('div', 'ws-polaroid-grid');
        all.slice(0, 60).forEach(function (p) {
          var pc = h('div', 'ws-polaroid-cell' + (picked[p.id] ? ' is-on' : ''));
          var thumb = h('div', 'ws-polaroid-thumb');
          pc.appendChild(thumb);
          pc.appendChild(h('span', null, p.caption || shortDate(p.at)));
          grid.appendChild(pc);
          if (Sleepy.photos && Sleepy.photos.srcOf) {
            Sleepy.photos.srcOf(p).then(function (src) {
              if (src) thumb.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
            });
          }
          pc.addEventListener('click', function () {
            if (picked[p.id]) { delete picked[p.id]; pc.classList.remove('is-on'); return; }
            if (Object.keys(picked).length >= MAX_PICK) { ctx.toast('最多贴 ' + MAX_PICK + ' 张', 'warn'); return; }
            picked[p.id] = 1;
            pc.classList.add('is-on');
          });
        });
        pop.el.appendChild(grid);
        var done = h('button', 'ws-polaroid-done', '贴上去');
        done.type = 'button';
        done.addEventListener('click', function () {
          widgetCfgSet(cell.i, { photoIds: Object.keys(picked) });
          pop.close();
          paint();
          ctx.toast('贴好了', 'ok');
        });
        pop.el.appendChild(done);
        pop.place();
      });
      return box;
    },

    /* 自定义模板组件（批4）：cell.tplId 指向 customWidgets 里的模板。
       安全链：模板入库前已消毒，渲染时再消毒一次（双保险）+
       CSS 钉作用域 + 只做变量替换。 */
    custom: function (cell, ctx) {
      var box = h('div', 'widget w-custom cust-' + cell.i);
      var scope = '.cust-' + cell.i;
      function paint() {
        box.innerHTML = '';
        var tpl = customTplOf(cell.tplId);
        if (!tpl) {
          box.appendChild(h('div', 'w-custom-empty', '模板不见了'));
          return;
        }
        var styleEl = h('style');
        styleEl.textContent = scopeCss(sanitizeTpl(tpl.css), scope);
        box.appendChild(styleEl);
        var body = h('div', 'w-custom-body');
        body.innerHTML = substituteVars(sanitizeTpl(tpl.html), cell.i);
        box.appendChild(body);
      }
      paint();
      /* {{photo}} 的图是异步的：拉到后缓存并重画一次（每个 cell 只踢一次） */
      kickCustomPhoto(cell.i, paint);
      return box;
    },

    /* 慢递信箱（批4）：char 在回复里写 [慢递:N|信]，到点才能拆。
       列表按岛隔离（core.scoped）；点已到的信拆开（标记 opened），
       没到的只给「N 小时后到」，绝不提前剧透内容。 */
    slowmail: function (cell, ctx) {
      var box = h('div', 'widget w-slowmail');
      function letters() {
        var list = [];
        try { list = core.scoped(store.get('slowLetters') || []); } catch (e) {}
        return list;
      }
      function paint() {
        box.innerHTML = '';
        var list = letters().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        var now = Date.now();
        var arrived = list.filter(function (l) { return (l.deliverAt || 0) <= now; });
        var unread = arrived.filter(function (l) { return !l.opened; }).length;
        var pending = list.length - arrived.length;
        box.appendChild(h('div', 'w-slowmail-emoji', '✉'));
        if (unread) {
          box.appendChild(h('div', 'w-slowmail-big', unread + ' 封可拆'));
        } else if (pending) {
          var next = list.filter(function (l) { return (l.deliverAt || 0) > now; })
            .sort(function (a, b) { return (a.deliverAt || 0) - (b.deliverAt || 0); })[0];
          var hrs = Math.max(1, Math.ceil((next.deliverAt - now) / 3600000));
          box.appendChild(h('div', 'w-slowmail-big', '一封在途'));
          box.appendChild(h('div', 'w-slowmail-sub', '约 ' + hrs + ' 小时后到'));
        } else {
          box.appendChild(h('div', 'w-slowmail-big', '信箱是空的'));
          box.appendChild(h('div', 'w-slowmail-sub', 'ta 写了慢递信就会出现在这'));
        }
      }
      function hoursLeft(l) {
        return Math.ceil(((l.deliverAt || 0) - Date.now()) / 3600000);
      }
      paint();
      box.addEventListener('click', function () {
        var list = letters().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        if (!list.length) {
          ctx.toast('还没有信 —— ta 在回复里写 [慢递:小时|内容] 就会有一封', 'warn');
          return;
        }
        var pop = ui.anchorPopover(box, { className: 'ws-slowmail-pop', width: '252px' });
        pop.el.appendChild(h('div', 'ws-slowmail-title', '信箱'));
        list.forEach(function (l) {
          var arrived = (l.deliverAt || 0) <= Date.now();
          var line = h('div', 'ws-slowmail-line' + (arrived ? '' : ' is-pending'));
          line.appendChild(h('span', 'ws-slowmail-line-main',
            arrived
              ? ((l.opened ? '已拆 · ' : '可拆 · ') + (l.charName || 'ta') + '的信 · ' + shortDate(l.createdAt))
              : ('在途 · ' + hoursLeft(l) + ' 小时后到')));
          line.appendChild(h('span', 'ws-slowmail-line-sub', (l.charName || 'ta') + ' · ' + (l.hours || 1) + 'h 慢递'));
          if (arrived) {
            line.addEventListener('click', function () {
              pop.close();
              ui.prompt({
                title: (l.charName || 'ta') + '的信',
                note: '慢递 ' + (l.hours || 1) + ' 小时 · ' + shortDate(l.createdAt) + ' 写下',
                fields: [
                  { key: 'body', value: l.body || '', multiline: true, rows: 6 }
                ],
                wide: true,
                ok: '收好了'
              }).then(function () {
                if (!l.opened) {
                  l.opened = true;
                  var all = store.get('slowLetters') || [];
                  for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === l.id) all[i].opened = true;
                  store.set('slowLetters', all);
                }
                paint();
              });
            });
          }
          pop.el.appendChild(line);
        });
        pop.place();
      });
      return box;
    },

    /* ---------------- 音乐卡（第 3 屏主件） ----------------
       用户给的参考是一张横版播放卡：左边一块方形封面，右边歌名 / 歌手 /
       「正在播放」，下面一排「上一首 · 播放 · 下一首」、一条进度条、
       右下角「随机播放」。用户的话是「不要这个颜色，但是大概长这样！
       做好看点好吗」—— 参考图是深紫黑的星空，跟这个项目的
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
             原始需求「点击就可以编辑文字~」。
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

       设计确认了两件事：
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
          /* 把格子序号带上：点哪个格，新照片就落到哪个格（不再是追加到队尾） */
          (function (slotNo) {
            slot.addEventListener('click', function () { addWallPhotos(ctx, slotNo); });
          })(i);
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
         以前取的是名册第一件，跟「我的大号」是两回事（需求 2026-09-21 拍板）。 */
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

  /* per-cell 组件配置（批3 简单砖/拍立得）：键 = cell.i。
     全局小键（不带岛章）：cell.id 只在当前岛的覆盖层里有意义，
     换岛后孤儿条目无害且极小 —— 跟 desktopRemoved 一个量级，不做清理。 */
  function widgetCfgOf(cellId) {
    var m = store.get('widgetCfg') || {};
    return m[cellId] || null;
  }
  function widgetCfgSet(cellId, patch) {
    var m = store.get('widgetCfg') || {};
    m[cellId] = Object.assign({}, m[cellId] || {}, patch);
    store.set('widgetCfg', m);
  }

  /* ---------- 自定义组件（批4，施工卡-组件商城-v1） ----------
     user 写 HTML/CSS 模板 + {{变量}}。安全边界：**只做变量替换、不执行脚本**
     —— sanitizeTpl 剥 <script>/on*= 事件属性/javascript:；CSS 由 scopeCss
     钉在组件自己的作用域里（.cust-<cellId> 前缀），漏不出去污染全站。 */
  function sanitizeTpl(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<\/?script[^>]*>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
      .replace(/javascript\s*:/gi, '');
  }
  function scopeCss(css, scope) {
    return String(css || '').replace(/(^|\})\s*([^{}@]+)\{/g, function (m, brace, sel) {
      var parts = sel.split(',').map(function (s) {
        s = s.trim();
        return s ? scope + ' ' + s : s;
      });
      return brace + ' ' + parts.join(',') + ' {';
    });
  }
  /* 变量白名单（施工卡批4）：同步取值，取不到回空串（显示留白不报错）。
     {{photo}} 是异步图（相册 IDB）—— 走 customPhotoCache：先给上次缓存的
     地址，kickCustomPhoto 拉到新图后再重画一次（每个 cell 一次，不闪）。 */
  var customPhotoCache = {};
  function widgetVars(cellId) {
    var d = new Date();
    var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var v = {
      time: bigTime(d),
      date: (d.getMonth() + 1) + '月' + d.getDate() + '日',
      weekday: WD[d.getDay()],
      weather: '', weatherCity: '',
      photo: customPhotoCache[cellId] || '',
      lampNote: '', charName: '', todoCount: '0'
    };
    try {
      var w = store.get('rwWeatherLast');
      if (w && w.temp) { v.weather = w.temp + '° ' + (w.desc || ''); v.weatherCity = w.city || ''; }
    } catch (e) { /* 没有天气就留白 */ }
    var notes = lampNoteList();
    if (notes.length) v.lampNote = notes[notes.length - 1].text;
    var me = core.activeCharOnIsland ? core.activeCharOnIsland() : null;
    if (me && me.name) v.charName = me.name;
    try {
      var todos = getTodos() || [];
      var undone = 0;
      for (var i = 0; i < todos.length; i++) if (!todos[i].done) undone++;
      v.todoCount = String(undone);
    } catch (e) { /* 待办读不到就 0 */ }
    return v;
  }
  function substituteVars(html, cellId) {
    var v = widgetVars(cellId);
    return String(html || '').replace(/\{\{\s*([a-zA-Z]+)(?::([^}]*))?\s*\}\}/g, function (_, key, arg) {
      if (key === 'countdown' && arg) {
        var t = new Date(String(arg).trim() + 'T00:00:00');
        if (isNaN(t.getTime())) return '';
        var now = new Date();
        var base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var n = Math.round((t.getTime() - base.getTime()) / 86400000);
        return n > 0 ? n + ' 天' : (n === 0 ? '今天' : '过了 ' + Math.abs(n) + ' 天');
      }
      if (key === 'photo') kickCustomPhoto(cellId);
      return v.hasOwnProperty(key) ? v[key] : '';
    });
  }
  function kickCustomPhoto(cellId, onReady) {
    if (customPhotoCache[cellId]) return;
    var all = wallPhotos();
    if (!all.length || !Sleepy.photos || !Sleepy.photos.srcOf) return;
    var p = all[Math.floor(Math.random() * all.length)];
    Sleepy.photos.srcOf(p).then(function (src) {
      if (!src) return;
      customPhotoCache[cellId] = src;
      if (onReady) onReady();
    });
  }
  function customTplOf(tplId) {
    var list = [];
    try { list = core.scoped(store.get('customWidgets') || []); } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === tplId) return list[i];
    }
    return null;
  }

  function wallPhotos() {
    var list = store.get('photos');
    if (!Array.isArray(list)) return [];
    /* 照片墙跟着当前角色走（2026-10-06 相册按账号隔离）：本角色的 +
       没记归属的老照片，别的角色的一张不露 —— 这是 TA 的桌面。
       群岛刚落还没选人时 activeCharOnIsland() 是 null，只给老照片，
       绝不拿上一个岛的 charId 顶数（见 core.js 那条指针卫兵的注释）。 */
    var me = core.activeCharOnIsland ? core.activeCharOnIsland() : null;
    var myId = me ? me.id : '';
    return core.scoped(list).filter(function (p) {
      return !p.ownerCharId || p.ownerCharId === myId;
    });
  }

  function shortDate(at) {
    var d = new Date(at || Date.now());
    return (d.getMonth() + 1) + '.' + d.getDate();
  }

  /* 选图 → 交给 photos 数据层落库。
     图片本体在 IndexedDB 图库里，存档里只留 mediaId（photos.js 负责
     缩放 / 配额 / 新老记录兼容）。这里以前写的是「localStorage 只有 5MB，
     必须缩放后再存」—— 那是接 IDB 之前的说法，已经不准了（2026-09-21）。 */
  function addWallPhotos(ctx, slotIdx) {
    if (!Sleepy.photos || !Sleepy.photos.pick) {
      ctx.toast('相册模块没加载出来', 'err');
      return;
    }
    Sleepy.photos.pick({ title: '加进照片墙' }).then(function (added) {
      if (!added || !added.length) return;
      /* 点格加格（2026-10-31 反馈）：以前 pick 一律追加到队尾，
         表现是「点了 5 号格照片却出现在 1 号格后面」。现在把刚加的
         这几张**搬**到「可见列表第 slotIdx 张」的绝对位置 ——
         注意只能搬不能重拼：photos 是全量表，别的房 / 别的角色的
         记录都在里面，搬错了就是把别人的照片挪走。 */
      if (typeof slotIdx === 'number' && slotIdx >= 0) {
        var movedIds = {};
        added.forEach(function (p) { movedIds[p.id] = 1; });
        var list = store.get('photos');
        if (!Array.isArray(list)) list = [];
        var me = core.activeCharOnIsland ? core.activeCharOnIsland() : null;
        var myId = me ? me.id : '';
        var sid = (core.activeSandbox() || {}).id || '';
        var moved = [];
        var rest = list.filter(function (p) {
          if (p && movedIds[p.id]) { moved.push(p); return false; }
          return true;
        });
        /* 搬完再数「墙上第 slotIdx 张」在 rest 里的绝对位置 */
        var visCount = 0, at = rest.length;
        for (var i = 0; i < rest.length; i++) {
          var p = rest[i];
          if (!p) continue;
          if (sid && p.sandboxId !== sid) continue;
          if (p.ownerCharId && p.ownerCharId !== myId) continue;
          if (visCount === slotIdx) { at = i; break; }
          visCount++;
        }
        var args = [at, 0].concat(moved);
        rest.splice.apply(rest, args);
        store.set('photos', rest);
      }
      ctx.toast('加了 ' + added.length + ' 张', 'ok');
      if (ctx.repaint) ctx.repaint();
    });
  }

  function bigTime(d) {
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
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
     报错弹窗比「不动」更烦人。

     ⚠️ 吸附按**节点中心点**算，不按左上角（2026-10-06：把 app 放到
     第 2 屏「预设」那一行下面，结果说放不下）。按左上角算时，手指把组件
     拖到最后一行，左上角还卡在倒数第二行（那是被占的格）→ 幽灵一直红、
     松手报「那儿放不下」。按中心算后，中心进了哪格就是哪格，
     最后一行 / 最边一格都够得着 —— iOS 桌面也是这个算法。 */
  function snapTo(grid, ctx, cx, cy, w, h) {
    var step = cellStep(grid, ctx);
    var o = gridOrigin(grid, ctx);
    var cellW = step - GRID_GAP;             /* 纯格子边长（step 含 gap） */
    var left = cx - (w * cellW + (w - 1) * GRID_GAP) / 2;
    var top = cy - (h * cellW + (h - 1) * GRID_GAP) / 2;
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
      /* pid：pointerId，长按起拖和跨屏换节点之后要靠它把指针捕获补回来 */
      down = { x: p.x, y: p.y, t: Date.now(), moved: false, node: node, pid: e.pointerId };

      if (editing) {
        /* 编辑态里立刻起拖，不等待 */
        e.preventDefault();
        startCellDrag(node, cell, pi, ctx, p, e.pointerId);
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
        /* 长按起拖时指针还悬在组件上，但一旦动起来就可能滑出组件边界 ——
           这条路起拖时 editing 还是 false，上面的 pointerdown 没设过捕获；
           不补的话 pointermove 会改道别的元素，拖到半路就「断线」，
           组件僵在半空（需求 2026-10-06：进入编辑态后 app 很难移动）。 */
        if (node.setPointerCapture && down.pid != null) {
          try { node.setPointerCapture(down.pid); } catch (err) { /* 指针可能已抬起 */ }
        }
        startCellDrag(node, cell, pi, ctx, { x: down.x, y: down.y }, down.pid);
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

    function onCancel() {
      /* pointercancel / touchcancel = 浏览器把手势抢走了（开始滚屏之类），
         不是用户松手。按「松手」处理会把组件落到半路的格子上，
         看起来像自己乱跳；这里直接弹回原位。 */
      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      if (dragState) cancelCellDrag();
      down = null;
    }

    /* 拖动进行中必须拦掉 touchmove 的默认行为，否则浏览器会把这次手势
       判成滚屏，滚起来之后拖拽就被 pointercancel 掐断了。
       只在真的在拖时拦 —— 平时按住组件滑屏翻页不受影响。 */
    node.addEventListener('touchmove', function (e) {
      if (dragState) e.preventDefault();
    }, { passive: false });

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
      node.addEventListener('pointercancel', onCancel);
    } else {
      node.addEventListener('touchstart', onDown, { passive: false });
      node.addEventListener('touchmove', onMove, { passive: false });
      node.addEventListener('touchend', onUp);
      node.addEventListener('touchcancel', onCancel);
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
     （需求 2026-09-21：「组件和 app 还不可以跨屏幕移动喔」）。 */
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

  function startCellDrag(node, cell, pi, ctx, p, pid) {
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
      pointerId: pid,
      /* 「蹭边缘翻屏」的一次性开关。翻过去之后指针还停在边缘区里，
         如果不管它，下一帧 relX 依然超界 → 又翻一屏 → 一路翻到最后一屏，
         用户根本落不到中间那几屏。所以翻完就卸武装，
         必须先把指针挪回中间区才重新武装（一次边缘 = 一屏）。
         **起手时不武装**：最左/最右一列的组件，手指天生就落在边缘区里，
         初始就武装的话一动就误翻屏（需求：组件难挪、会自己飞走）。 */
      edgeArmed: false,
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
    /* appendChild 会把节点从旧父节点摘下来再插回去 —— 浏览器随之
       **释放指针捕获**，后面的 pointermove 全部改道别的元素，
       跨屏拖到一半必然断线。换完屏立刻把捕获补回来。 */
    if (st.pointerId != null && st.node.setPointerCapture) {
      try { st.node.setPointerCapture(st.pointerId); } catch (err) { /* 指针可能已抬起 */ }
    }

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
       注意把 **当前这一屏的 grid** 传进去 —— 用 ctx 反查会拿到第 0 屏的网格。
       吸附点取**节点中心**（scale 1.06 不影响中心），原因见 snapTo 的注释。 */
    var r = st.node.getBoundingClientRect();
    var spot = snapTo(st.grid, st.ctx,
      r.left + r.width / 2, r.top + r.height / 2, st.cell.w, st.cell.h);
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
           高屏上网格比整屏矮，要往下挪（需求 2026-09-22 报「下面空一片」，
           10-06 报「整体下移」，当晚又报「别沉底，差不多从第二行开始」）。
           最终版：flex + 固定留一行（见 .dt-screen.is-neg1，别用
           align-content —— 对内容自适应的网格是无操作，教训在 style.css）。 */
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
             （需求：桌面一滑动就进编辑）。 */
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

      /* 维稳（2026-10-31 反馈「太顺滑了，从第一屏直接滑到最后一屏」）：
         scroll-snap mandatory 只保证「停在某屏上」，拦不住惯性一口气
         滚过好几屏。两道限幅：
         ① 触屏 —— touchstart 记起手屏，touchend 静止后只允许落在
            「起手屏 ±1」，超出就拉回来（一次手势最多翻一屏）；
         ② 滚轮 / 触控板 —— 连环 deltaX 事件会把惯性放大成穿越，
            260ms 内最多翻一屏，翻页走 smooth 有过渡不生硬。 */
      var gestureScreen = null;
      scroller.addEventListener('touchstart', function () {
        gestureScreen = Math.round(scroller.scrollLeft / (scroller.clientWidth || 1));
      }, { passive: true });
      scroller.addEventListener('touchend', function () {
        var from = gestureScreen;
        gestureScreen = null;
        setTimeout(function () {
          var w = scroller.clientWidth || 1;
          if (!w) return;
          var cur = Math.round(scroller.scrollLeft / w);
          var lo = (from == null) ? -Infinity : from - 1;
          var hi = (from == null) ? Infinity : from + 1;
          var want = Math.max(lo, Math.min(cur, hi));
          if (want !== cur) jumpTo(want * w);
        }, 140);
      }, { passive: true });
      var wheelLock = 0;
      scroller.addEventListener('wheel', function (e) {
        if (!e.deltaX) return;
        e.preventDefault();
        var now = Date.now();
        if (now - wheelLock < 260) return;
        wheelLock = now;
        var w = scroller.clientWidth || 1;
        var cur = Math.round(scroller.scrollLeft / w);
        var want = Math.max(0, Math.min(pages.length - 1, cur + (e.deltaX > 0 ? 1 : -1)));
        scroller.scrollTo({ left: want * w, behavior: 'smooth' });
      }, { passive: false });

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
         原始需求：「每次点进去之后要加载一段时间才能点击主屏的图标，
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

      /* 桌面存档变了就重画（2026-10-30 幽灵组件根治）。
         桌面是 bootHome 挂的**常驻基底页**，不在页面栈里 —— 从任何
         App 页返回桌面都**不触发重画**（onShow 只喊栈里的页）。
         于是组件商城「加到桌面 / 拿下来」之后回桌面，DOM 全是旧的：
         新件看不见、删掉的还在（再点叉叉就是幽灵格，数据里早没它了）。
         订阅 store：desktop 一写就重画，读写永远同步。
         ⚠️ 必须异步 + 拖拽中跳过：store.set 在 setDesktop 里**同步** notify，
         拖拽落格（endCellDrag）写完档还有后续 DOM 操作，同步重画会把
         它手里的节点连根拔掉。
         ⚠️ render 可能被 bootHome.force 重放：重订阅前退订上一份，
         老闭包的 scroller 已脱文档就别再画了。 */
      if (Sleepy.__desktopStoreWatchOff) Sleepy.__desktopStoreWatchOff();
      Sleepy.__desktopStoreWatchOff = store.onChange(function (path) {
        /* appearance 也算（2026-10-31 维稳）：单 App 名称/图标覆盖存在
           appearance 键里 —— 以前只听 desktop，外观页改完世界书图标
           网格纹丝不动，只有外观页原地刷的 dock 变了。 */
        if (path !== 'desktop' && path !== 'appearance' && path !== '*') return;
        setTimeout(function () {
          if (dragState) return;
          if (!scroller.isConnected) return;   /* 旧 render 的闭包，DOM 已换血 */
          if (ctx.repaint) ctx.repaint();
        }, 60);
      });
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
    overlap: overlap,
    /* 商城页「移除」也走这一笔账 —— 不导出它的话商城只能自己抄一份
       记录格式，格式一改两处就悄悄岔了（2026-10-06 橱窗批）。 */
    rememberRemoved: rememberRemoved,
    /* 自定义组件的消毒/作用域/变量替换 —— 唯一实现在本文件，
       商城编辑器（实时预览/保存）只调用不抄写（批4）。 */
    customTpl: {
      sanitize: sanitizeTpl,
      scope: scopeCss,
      substitute: substituteVars
    },

    /* 挂件灯的卡片装配（留言 + 空板补数到 36 个挂点）—— 冒烟要核
       「一条留言只挂一个挂点、不四层重复」，不导出的话测试只能抄一份
       装配逻辑，那就成了判据与被测物各一份（假绿）。 */
    lampCards: lampCards
  };

  /* 首页是基底页，不走页面栈，它的 render 必须有人主动调一次
     （见 app.js 的 Sleepy.bootHome 注释）。
     注意点火时机：page-switch.js 会给 home 的 render 包一层，
     所以不能在这里调 —— 这里调时它还没加载，包装就落在渲染之后了。
     真正的点火放在最后一个脚本（page-chat-settings.js）的末尾。 */

})(window);
