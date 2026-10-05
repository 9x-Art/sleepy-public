/* ============================================================
   sw.js — Sleepy 的 Service Worker（PWA 离线壳）
   策略：**运行时缓存 + 缓存优先**，外加一次安装期的整壳预热。

   为什么要「预热」而不只靠运行时缓存：**首次访问时 SW 还没控制这个页面**，
   页面自己发的那些 <script> 请求根本不经过 fetch 处理函数 —— 一个都存不下。
   只靠运行时缓存的话，离线可用要等到**第二次**打开才成立；中间只要断网，
   用户看到的就是「有壳没 app」的残页。
   所以 install 期额外走一遍 warmShell()：读 index.html 的文本、正则出
   全部本地资源逐个塞缓存。**仍然没有写死清单** —— 脚本列表继续长也不会漏。

   更新：版本号 CACHE 一改，旧缓存整体清掉；
   skipWaiting + clients.claim 让新版立刻接管，不用关两次页面。
   （file:// 不走 SW，本来就是全离线的，两边正好互补。）

   v166（2026-10-05）：**群线上动态上下文补齐（K03f）**——
   · page-group-ai：composeRound 接四源（权限等级分开装配）——
     世界书按知情范围分流（全局书 → 共享块；个人书 → 挂靠本体的 [ENTITY] 块，
     群外角色的不注入）；逐本体语言行（只说说什么语言，不带私聊译文协议）；
     近期生活动态逐本体（lifeFeed 已按角色过滤）；自定义卡只接显式标记
     「群聊可用」的卡，没标记 = 私聊专属不广播。
   · prompt-engine：新增 compileWorldbookGroup（shared + perEntity 双出口）与
     compileLangGroup，导出面补齐；自定义卡 schema 加可选 group 字段。
   · page-presets：自定义卡编辑页加「群聊可用」开关（默认关）。
   → 必须跳版本：prompt-engine.js / page-group-ai.js / page-presets.js 都变了。

   v165（2026-10-05）：**ta-life 三表接入私聊线上/线下/主动消息（K03e）**——
   · ta-life：新增 compileLivingLife（统一编译出口，只读零模型零写入）：
     按真实状态筛选三表（items 终止=已完成；promises 终止=已兑现/已解除；
     follows 无状态机全有效），选序稳定（相关二字片段 > 状态优先级 > updatedAt），
     每类最多 2 条 + 900 字预算，pending 提案（taProposals）完全不经过它。
   · prompt-engine：新增 K03e 槽（talife）与 compileTaLife 包装
     （惰性取模块 + try/catch 回空串），assembleOnline / assembleOffline 各接一 case；
     线下 query 抽成 offlineLastUserQuery（K03d/K03e 共用，取法只此一份）。
   · page-proactive：buildSystem 在 recall 与 worldbook 之间 push K03e，
     直接调 PE.compileTaLife（不挂弱导出守卫），匹配文本用真实最近聊天原文。
   → 必须跳版本：prompt-engine.js / ta-life.js / page-proactive.js 都变了。

   v161（2026-10-04）：**群线上接入冻结 B/P/L/E/S4**——
   · prompt-engine：只把 `BT_SPECS.groupOnline` 的
     `injectShell`/`injectScene` 由 `false/false` 改为 `true/true`，
     连带删掉「shell 与 plans 两条要求互斥」的断言（用户裁决：**不注入旧 shell、
     不做裁节机制**）。C1 核对已确认 `plans[].internalUpdate` 是**可选结构化状态**
     （`validateRound` 不要求存在、不校验类型/长度；`saveInner`/`saveDefer`
     截断至 120 字）。**本批不注入旧 shell 卡，因此未证明 shell ⑦
     构成本批接线的阻碍**（不注入 ≠ 已证明互斥不存在）。共享决策工厂未动。
   · page-group-ai：`composeRound` 顺序固定为
     **B/P/L → groupRound → E/S4 → 原有群现场信息**。
     `btDecideScene` 只调用一次；两段**各自**满足
     「ok + 对应 inject 为 true + 正文是非空字符串」才 push，并按**实际 push** 记账。
     groupRound 卡及 [GROUP] / [ENTITY_KNOWLEDGE] / 编号禁令**正文一行未改**，
     解析/校验/存取/投递一律未动，**本批不新增任何存储写入**。
     诊断只在内存（`groupAI.behaviorNote()` 返回**只读深拷贝**），
     每次尝试开头重置 —— 早退也不留上轮的成功记账。
   · 诊断正常态：`modules=['B','P','L','E','S4']`、`pendingModules=[]`、
     `partial=false`、`shellCard='behavior'`。

   v160（2026-10-04）：**共享行为决策层 + 主动消息/群线下最小接线**——
   · prompt-engine：新增 `btDecide(spec)` 为**五场景唯一实现**（十步校验）。
     原 btOnlineDecision / btOfflineDecision 改成**薄包装**（返回字段逐字不变），
     因为 behavior-offline-migration-test.js 的 67 条断言锚在它们身上。
     新增 spec 护栏 G1–G8（未知场景 / 契约形状 / 重复模块 / 非布尔 inject 标志
     一律 throw，由 btDecideScene 接住转成整条回退，**不向页面泄漏异常**）。
     ★ G4 允许 S1–S5 任意场景专属段（只做形状校验；
       「scene 契约 == 计划剩余序列」留到拿到真 plan 之后再判）。
   · 诊断口径：`modules` 只报**真的进 system** 的模块；未接通的进 `pendingModules`
     且 `partial=true`；`sceneSkippedByOverride` 区分「被 override 跳过」
     与「本批没接通」。工厂不提前宣称，调用方装配完成后经 `btNote` 回报。
   · page-proactive：默认注入 B/P/L/E/S3，**proactive 协议卡保留在原位**
     （顺序 shell → 卡 → E/S3）。proactive 卡被 override → 保留 B/P/L、
     跳过 E/S3；shell 被 override → 整条回退。
   · page-group-offline：**部分接线**，只注入 B/P/L；
     f2 / [SCENE] / [PARTICIPANTS] / [LANGUAGES] / [PRESENCE RULES] / [OUTPUT]
     **全部原样保留**，N/S5 暂不进 system。
   · page-group-ai.js **本批零改动**（shell 卡与 groupRound 的
     plans[].internalUpdate 存在硬冲突，接线前需先裁决）。
   · 诊断只落内存、只读深拷贝快照，**本批不做 UI**；Sleepy.offlineDiag 未动。
   ⚠️ 已知待裁决：smoke「通查②」断言主动消息 system 含 `[角色声音]`。
     `[角色声音]`/`[身份与场景]` 属 shell **卡**正文，行为文本 B 批起
     私聊线上 shell 位已被 B/P/L 顶替、同样不含这两节 —— 接线后 proactive
     与线上对齐。该断言是行为文本之前写的，本批**未擅自改断言也未改产品**。

   v159（2026-10-04）：**解析失败记录不再进模型上下文**（P0 返修第二批）——
   起因：v158 的降级消息 `paras` 里那句中性标记会**以角色身份**进历史 ——
   证据里出现「沈砚：这一轮的回复格式出了点问题。」，
   模型会把它当成角色说过的台词。中性措辞解决不了**角色归属污染**。
   · prompt-engine `assembleOffline` 的 **history 槽**：按 **parseFailed 状态**
     排除失败记录（**不按文案匹配** —— 文案会改，状态不会）。
     ⚠️ 先过滤再 `slice(-20)`，否则被排除的记录仍占额度、只剩 19 条。
   · 同函数 **worldbook 槽**同样排除：失败标记不是世界书素材，
     留着会让世界书按一句无关提示去匹配。
   · page-offline `generateSummary` 同样排除：否则总结里会出现
     一句角色没说过的话。
   · 解析器、协议、offlineOutProto、B/P/L/N/S2、诊断、UI 记录全部未动；
     **失败记录仍完整留在会话里并在 UI 正常渲染**，只是不进任何模型上下文。
   ★ 附带查明（实测，如实记录）：rawReturn 的内存容器在 page-offline.js 的
     **模块作用域**（IIFE 内），生命周期等于**整个页面**而不是单个场景页 ——
     离开页面再回来原始返回仍在，**刷新才丢**。本批只核对不改动。
   → 必须跳版本：prompt-engine.js / page-offline.js 都改了。

   v158（2026-10-04）：**线下解析失败的用户可见降级**（P0 · 方案 A）——
   起因：真机效果验收发现模型有相当比例返回**语法不合法的 JSON**
   （`{"type":"prose":"…"}` 缺冒号 / 末尾截断 / 输出「修正版：」双份），
   以及 **HTTP 200 但 content 为空**；旧代码把降级后的整段原文当 paras 渲染，
   正文里直接出现裸 JSON。
   · page-offline：`parseOfflineReply` 返回 `ok:false` 时（坏 JSON **与**空串统一）
     走一条专用降级路径 —— 正文一条人话提示 + **默认折叠**的「查看原始返回」。
   · `prompt-engine.js` 的 `parseOfflineReply` **一行未改**（它的降级行为是对的，
     问题在消费方无条件照单渲染）；协议 / offlineOutProto / B·P·L·N·S2 /
     诊断 / 超时 / 重试 / maxTokens 全部未动。
   · ★ **rawReturn 只放模块级内存 Map**，绝不挂消息对象 ——
     `appendMessage → mutateSession → saveAll` 会把挂在 msg 上的字段写进 store，
     挂上去等于把模型原始返回落库。刷新 / 离开即失，不进 store / 导出 / 收藏 /
     日志 / 诊断，也不被「通用消息持久化逻辑」顺手保存。
   · 降级消息的 `paras` 里**只有一句中性失败标记**（不含「JSON」「格式错误」这类词，
     否则下一轮模型会读到「上一轮出了个 JSON 错」这种莫名其妙的话）。
   · 成功路径（paras / trans / suggests / envUpdate / scene）完全不受影响。
   → 必须跳版本：page-offline.js / style.css 都改了。
   ⚠️ 本条只证明降级可见性与数据隔离，**模型效果仍未验收**；
     style.css / sw.js 两个文件已混有多批此前改动，本批只追加、不改既有行。

   v157（2026-10-04）：**线下请求诊断返修**（F1/F2/F3 三处真缺陷）——
   ⚠️ v156 那版把 page-offline.js 改成了**模块级就崩**的状态，本条是修它。
   · **致命**：`STAGE_TO_DIAG`（引用 DIAG_STAGE 的值）被放在 DIAG_STAGE
     声明**之前**。`var` 会提升但值是 undefined → 模块顶层求值即抛 TypeError
     → 整个 page-offline.js 的导出全丢（Sleepy.offlineStore / offlineUI /
     offlineDiag 全变 undefined，**线下场景功能完全不可用**）。
     同时导出面上挂着 `__recordIfCurrent: diagRecordIfCurrent`，
     而那个函数 v1 删了之后**从未定义** → 又一个 ReferenceError。
     修法：诊断常量块整体上移到使用点之前；导出面删到只剩两个只读入口。
   · **F1 请求身份**：`diagRecord` 每写一条就自增 `diagSeq`，v1 拿它当请求身份，
     于是「无连接」分支写一次诊断就把本请求作废，回调里
     `if (diagSeq !== seq) return;` 命中 → **整段业务回调被丢弃**，
     pending 永久占位、按钮不解禁、无错误提示。
     修法：拆成 `requestSeq`（请求身份，每次新请求只分配一次，阶段更新沿用）
     与 `diagSeq`（诊断记录序号，只给面板排序看）。守卫只管共享 UI 状态，
     **绝不丢弃业务回调**。
   · **异步边界**：请求身份改在 requestTurn 入口分配（预取阶段就占位 pending，
     否则召回那几百毫秒能连发两次）；预取回来先核对「页面还在 / 会话还在」，
     否则记 canceled 并收尾；onShow 重新置 `ctx.__alive`
     （页面实例缓存复用，只在 render 入口置位会导致离开一次后永久作废）。
   · **F2 失败语义**：只有 stage=http/parse 才算「服务端确实收到了并拒绝」；
     network/timeout/unknown **无法确认** → request-failed-unknown；
     config 是本地判定**没出网**。同步抛 / Promise reject / 非 thenable
     三条路径都收尾，不再沿用上次成功状态。
   · **F3 生产接口**：`Sleepy.offlineDiag` 只剩 `snapshot` / `stageLabel`。
     阶段/原因码/模块/版本全部走闭集校验，未知一律固定文案、不回显原串。
     面板字段 modelOk → requestOk，新增「请求身份」行。
   · 另修 `diagPanelRef` 词法作用域（声明在 buildSettingsSheet 内、
     refreshDiagPanel 在同层看不见 → 点「请求诊断」页签必 ReferenceError）。
   ⚠️ 只验接线与收尾，**模型效果仍未验收**；未提交 / 未 push / 未部署。

   v156（2026-10-03）：私聊线下接共用行为文本（B/P/L/N/S2）+ 线下最小请求诊断 ——
   线上那批之后，线下一直是全库唯一没有行为迁移的场景。
   · prompt-engine：新增 btOfflineDecision（槽位契约 shell=B/P/L、f2=N/S2，
     拼平逐项等于 PLANS.offline）；assembleOffline 两卡统一读决策结果，
     任一失败**整体**回退 cardBody，不混用半套；返回值加 behavior 诊断。
   · 线上专属的 f1 / c05 override **不再**牵连线下回退（线下只判 shell / f2）。
   · **输出协议一行未动**：线下 JSON 仍由既有 offlineOutProto + 消费者契约保障，
     本批不新建平行协议常量。
   · page-offline：诊断只从**实际出站那次**的 built 采集，区分装配失败 /
     已到达调用边界 / 模型已返回 / 无连接四阶段；仅内存保存最近一次，
     设置页「请求诊断」折叠查看，**不进沉浸正文、不入库不上传**。
   ⚠️ 模型效果**尚未真机验收** —— 本条只证明装配路径与回退语义。

   v155（2026-10-03）：假期表述按「节 ≠ 节假日」分层 + 给全事实 ——
   用户报「模型说今天是国庆第一天」，**换了几个 API 都一样**，上次中秋也犯过。
   根因不是措辞不精确，是**事实错了**：CN_OFFICIAL 的 name 是**整段连休的名**
   （国庆 = 10-01~10-07），而旧句式连着 7 天都说「今天是国庆节」—— 7 天里 6 天是假的。
   模型同时读到「今天是 10 月 3 日」和「今天是国庆节」两条打架的信息，
   只能采信假期名、忽略日期 → 说成「第一天」。**它不是算错，是我们逼它二选一。**
   ① 数据层改名：**假期名**（国庆假期/春节假期/清明节假期…），
      单日的 2025 元旦不加后缀（没有区间就没有歧义）；2025 合并块 → 国庆中秋假期。
      规则型区域（JP/US/UK/KR）全是 MM-DD 单日、name 就是当天名，**不动**。
   ② buildYear 记下区间与第几天（daysBetween 已含首尾，from 当天=第 1 天，别再 +1）。
   ③ 新增 calendar.publicDayLine —— **公共日期那一行的唯一出口**，
      timeFacts 与日历页日列表共用（以前两边各拼一次，同一个错显示两处）。
      句式改成「国庆假期（10月1日—10月7日，共 7 天）· 今天是 10月3日，是这段假期的第 3 天」
      —— 三件不需要模型推理的事实一次给全；单日假日仍走「今天是X（法定放假日）」。
   ④ 日历页多日连休标题带「第 3/7 天」；节日名与假期名不再按「名字相同」去重
      （那是拿节当节假日比）。
   → 必须跳版本：改了 calendar.js / calendar-data.js / page-calendar.js，
     老用户缓存优先复用旧代码，不跳位拿到的还是会瞎排的旧版。

   v154（2026-10-03）：孤岛/群岛马甲真隔离 + 彼此认知档位一致（用户真机报）——
   ① me-profile 改走**指针卫兵** activeUserOnIsland：原来用 activeUser，
      那个口子带 `|| ensureDefaultUser()` 的跨岛兜底 → 新岛打开「个人资料」
      会把**别座岛那件**当表单初值（用户看到的就是「表单 copy 过去了」），
      在这里改名 = 改别座岛的记录 → 「改孤岛B，其他岛账号全跟着变」。
   ② mask-edit 补岛归属闸（记录不属于要编辑的那座岛就拒，fail closed）；
      它原来只按 id 全局找，不校验归属 → 跨岛打开整个 copy 过去。
   ③ 时空切换器「新增马甲」补 sandboxId。
   ④ me-profile 的 doSave 显式回写 sandboxId（传 undefined 会被 has() 判成
      「显式给了空」→ 把岛章抹掉）。
   ⑤ 彼此认知：认知锁渲染门槛从 `mains && masks` 改成只看 `mains` ——
      档位是产品常量（LOCKS 四档），与此刻有几件马甲无关；以前新岛没马甲
      就整段不渲染（用户看到「一个岛有选项、一个岛没有」）。空马甲改为
      给出四档说明 + 「去哪加马甲」的指引。
   冒烟加了三条（数据层 + 静态），另立 scripts/browser-island-isolation-test.js
   走真浏览器端到端复验 14 项。四处修复都做了负向对照（退化即报红）。
   → 必须跳版本：改了 page-idcard.js / page-island.js / page-switch.js，
     页面级改动不跳位老用户拿到的是旧页面。

   v153（2026-10-03）：日历年缓存键漏了 cultures（跨角色串味修复）——
   `calendar.js buildYear` 的缓存键从 `year|region` 补成 `year|region|cultures`。
   文化节日那层是按 cfg.cultures 逐组铺的，旧键会让同一年的缓存被
   **第一个来问的 char** 定死：甲只选「中国传统节日」先问 2026，
   乙（选了国际节日）再问 12-25 就拿不到圣诞节；反向还会串到
   自己没选的中文节日。设置页每次点 chips 都调 clearCache()，
   所以**手动改完看着是对的**，漏的是「两个 char 交替问同一年」这条路
   （聊天 I02 注入与月历都会走）。冒烟补了两条护栏，其中一条**故意不清缓存**。
   → 必须跳版本：改了 calendar.js（不跳位老用户缓存优先复用旧代码）。

   v151（2026-10-03）：日历写入全链路收口（第三轮施工单）——
   ① saveAnniversary 改走 requestCreateEvent，并补入口边界三道闸
      （缺 memoryId / 本岛名册没有这条留痕 / 留痕不属于本角色），
      幂等键换成「anniversary:<sandboxId>:<memoryId>」（去掉标题日期弱键）；
      **补上双向绑定的反向那一半** —— 写回 memory.calendarEventId
      （以前全库没有一处写它，「双向绑定」其实只有单向）。
   ② wj-canon 定史改走统一入口，rec.written 只在「留痕都在 + 日历全落成」
      时置真；日历部分失败留 calendarFailed / writtenPending，可重跑补，
      rec.eventRefs 存真实 eventId。事件类型三元（两分支同值）按原样保留。
   ③ addEvent 从 Sleepy.calendar 顶层导出表拿掉，只挂 __internal.addEvent
      （测试夹具专用）；生产脚本碰它就红。
   → 必须跳版本：改了 calendar.js / wj-canon.js / page-wj-canon.js /
     page-memory.js / style.css —— 尤其 calendar.js 的导出表变了，
     不跳位老用户拿到的还是能直接调 addEvent 的旧版。

   v150（2026-10-03）：日历真机反馈三修 ——
   ① 新建入口从右下角悬浮加号挪到**顶栏「设置」旁边**（用户：固定死右下
      有点遮屏幕，会压住列表最后一条日程）；`.cal-fab` 样式随之删除。
   ② page-calendar.js 的 calendar-new / calendar-event 声明 freshOnOpen：
      修「同一天再点加号，上次填的还在」与「记下他推掉了之后再看详情页
      还是待确认」—— 都是页面实例缓存 + 同参短路把旧 DOM 端了回来。
   → 必须跳版本：改了 page-calendar.js 与 style.css（顶栏按钮位置变了，
     不跳位老用户看到的还是右下角那个加号）。

   v149（2026-10-03）：日历安全边界与最小执行器（第二轮施工单）——
   新增 action.js（最小动作协议：request / attempt / result / receipt）；
   calendar.js 收紧 I02 日程层可见性（复用 life-feed 的 charViewOf，
   user 私人提醒不再进 char 的 prompt）、新增统一写入出口
   requestCreateEvent、冲突检测改为绝对时间区间（跨午夜 / 时区 /
   重复实例）、新增共同事件表态入口 respondSharedEvent；
   page-calendar.js 新建改走 action 层、详情页补「他的回应」；
   core.js 删房名单与 store.js 默认值加 actionRequests。
   → 必须跳版本：新增了一个运行时脚本，还改了 calendar.js / page-calendar.js /
     core.js / store.js / index.html —— 不跳位老用户缓存优先复用旧代码，
     动作模块根本不存在，而且那条隐私缺口还会继续留着。

   v148（2026-10-02）：ta 关系网 v1（第一批，**只读**）—— 新增
   ta-network.js（人物节点 / 关系边的唯一 selector）与 page-ta-network.js
   （关系图 + 列表双视图），index.html 两个 script 标签、
   page-ta.js「04 身边的人」改为消费同一 selector（并转发
   latestVisibleMoment），style.css 补 .tan-* 样式。
   → 必须跳版本：新增了两个运行时脚本、改了 page-ta.js / style.css /
     index.html —— 不跳位老用户缓存优先复用旧代码，关系网页根本不存在，
     首页 04 也会继续走旧的两套拼法。
   v147（2026-10-02）：ta 首页第五批 —— 已成立影响接入聊天与主动消息。
   新增 ta-impact.js（影响层：有效期/复核/事件更正/注入文本编译/主动消息回执），
   prompt-engine 新增 taimpact 槽（K03d，线上+线下各一处），
   page-chat 在回复落地后记「角色已有反应」，page-proactive 把决策结果
   写回 ta 提案，page-ta 人物详情/幕后新增影响区，style.css 补影响样式。
   → 必须跳版本：多个运行时脚本改了（prompt-engine / page-chat /
     page-proactive / page-ta / ta-proposal），不跳位老用户缓存优先
     复用旧代码，注入槽根本不会出现。
   v119（2026-09-27）：项目4 删除边界（forgetCharSet 按 fromCharId 集合精确命中）
   部署配套跳版本 —— 本次改动了运行时脚本 core.js / memory-vec.js /
   page-idcard.js / page-island.js / page-chat-settings.js，老用户 PWA 缓存里仍是
   旧删除语义，必须清掉整壳强制拉新。本版**未动任何 SW 业务逻辑**。
   → 必须跳版本：多个运行时脚本改了。
   v118（2026-09-26）：**部署入口修复** —— Cloudflare Pages 平台把 `/index.html`
   自动 308 → `/`，Android Edge 在 SW 控制下处理该 308 会 ERR_FAILED，导致 PWA
   桌面图标（manifest.start_url 原为 ./index.html）打不开。修：manifest.start_url/
   scope/id 全改为 `/`（图标直接启动 `/`，200 正常）；`_redirects` 把 `/index.html`
   显式重写为 `/` 的 200。跳版本只为让 **新 manifest.json 被重新缓存**（manifest 走
   SW 缓存优先，不跳版本浏览器永远读旧 start_url）。本版**未动任何 SW 业务逻辑**。
   → 必须跳版本：manifest.json 改了、新增了 _redirects。
   v117（2026-09-23）：开屏**收尾** —— 播完自动进桌面，另加一层预遮罩。
   · 上一版唯一的出口是 `pointerdown`：动画停在 sleepy 上就再也不动了，
     用户只看到名字停在那儿、以为卡死（得自己想起来点一下）。
     现在 sleepy 浮现完停住 `logoHold`，再 `finish(CFG.outFade)` 自己摘遮罩；
     点任意处仍然只是**提前**结束。`CFG` 新增 `logoHold:850` / `outFade:420`，
     全程约 9.5 秒进桌面。
   · index.html 的 `#phone` 里先写死一层夜色空壳 `#splash-pre`（行内样式），
     splash.js 一执行就把它**升级**成 `#splash`（换 id + 摘掉行内样式，不留两份样式）。
     **为什么非要有它**：splash.js 排在所有脚本最后，在它执行之前浏览器画的已经是桌面。
     探针实测：**桌面 742ms 渲染完、遮罩 881ms 才插进来** —— 中间那 139ms 就是
     「一进网址先闪一下主页」。有了预遮罩，第一帧就是夜色。
   · 三条早退（`?splash=0` / 没有 `#phone` / 减少动效）都要 `bail()` 掉预遮罩，
     漏一条就是**永久黑屏**；style.css 另加 `#splash-pre{animation:sp-bail …7s}` 兜底
     （splash.js 万一报错，7 秒后自己退开，不会把人锁在门外）。
   → 必须跳版本：index.html / style.css / splash.js 都改了。

   v116（2026-09-23）：**新增冷启动开屏**。`#phone` 里盖一层全屏遮罩
   （`splash.js`，`z-index:300`，连状态栏一起盖住），播一段约 8.2 秒的动画：
   十六句古今中外的诗句散落浮出 → 收敛成一个「爱」→ 天亮 → sleepy 浮现，
   然后摘掉遮罩，露出**早就渲染好的**桌面。点任意处可跳过。
   · **「减少动效」是 splash.js 自己拦的，不能靠 CSS** ——
     style.css 里那条 `[data-motion="off"] *{animation:none!important}` 只杀
     CSS 动画，**杀不到 WAAPI**（`el.animate()` 不受 `animation` 属性管辖）。
     系统级 `prefers-reduced-motion` 同理。两条命中就整段不播。
   · index.html 末尾新增 `<script src="splash.js" defer>`，**必须排最后**：
     `page-chat-settings.js` 末尾的 `Sleepy.bootHome()` 跑完，桌面才有内容；
     遮罩下面早就有东西，摘掉那一下才不会白屏。
   · style.css 末尾新增 `#splash` 一整套样式，外加 **Cormorant Garamond 的
     `@font-face`（base64 内嵌，只含 s l e p y 五个字形，1.88 KB）**。
     **内嵌而不是外链**：`file://` 下外链字体会被 CORS 拦掉，
     而「双击 index.html 就能开」是不能破的底线。
   · 颜色不写死：天亮亮到**当前主题**的 `--g-base`、sleepy 用 `--g-accent`，
     所以青提玻璃 / 海盐 / 蜜桃 / 夜灯下都不会跳色。
   · 调试开关：`?splash=0` 关掉、`?splash=1` 强制播放。
   · 不写任何「已播过」标记 —— 页面加载就等于冷启动（切页走 `.page` 栈，永不重载），
     加了存储只会让「刷新不播」，调不动。
   → 必须跳版本：index.html / style.css 都改了，且**新增了 splash.js**。

   v107（2026-09-22）：修「小号这里的名字点不了」—— 根因是**点标题不聚焦**：
   `.set-label` 是独立一行、既不包裹输入框也没有 `for`，而单行字段只有 34px 高、
   标题就贴在上方 11.5px 处，手指稍微偏上就落在标题上（看起来就是"字段点不动"）。
   · ui.js 新增 bindLabel()：给每个字段的标题绑上输入框（`for` + 自动 id），
     textField / numField / textArea / switchField 都接上了；page-island 的
     .iol-field（NPC / 身份抽屉）和 page-chat-settings 的抽屉也补了。
   · 单行字段的点击区 34px → **44px**（.simple-form 的 .set-input/.set-select/
     .iol-field input）。
   · 「会话列表里显示的名字（留空就用名字）」这个 placeholder 太长被裁掉半句
     → 缩成「会话列表里显示的名字 · 可留空」。
   · 顺手修：`.iol-field textarea` 的底色写死 rgba(249,247,243,.92) ——
     夜灯下是**深底一块白 + 浅字**（跟 .face-box / .set-textarea 同一类坑，
     那两处早改过、这里漏了）→ 改用 --g-fabric。
   · `.simple-form` 加 `padding-bottom:var(--kb-inset)`：键盘弹起时聚焦的字段
     才有地方滚上来（页面是自己的滚动容器）。
   → 必须跳版本：ui.js / style.css / page-idcard.js / page-island.js /
     page-chat-settings.js 全改了。

   v106（2026-09-22）：浮岛的文案块改成**按房型各写一份 top** —— 两张底图是
   分别生成的，岩尖高度不一样（实测屏幕 y：孤岛 506 / 群岛 476，差 30px），
   共用一个 top 的话群岛会空出 54px（用户：「其实群岛看会更明显」）。
   `.isl-page` 加了 `data-kind`，CSS 分两份（62.8% / 59.3%）。
   → 必须跳版本：style.css / page-island.js 都改了。

   v105（2026-09-22）：浮岛选岛页的「进 岛」按钮原来钉在 `bottom:42px`
   （几乎贴着屏幕底），用户看线上反馈「按钮太下面了」—— 文案和按钮之间隔着
   一大片云，读起来是两块不相干的东西。上移到 **120px**，跟文案凑成一组，
   下面留 120px 云海当呼吸。（那一段是真云，不是补色的底。）
   → 必须跳版本：style.css 改了。

   v104（2026-09-22）：**浮岛底图版本 2** —— 用户看线上后反馈「图往上挪一点、
   字体靠近一点、上面留白多下面很少」。做法不是裁天空（cover 下裁得越多岛越大），
   而是**给底图底部接 300px 云**（1264×1856 → 1264×2156）：图变高 → cover 缩放
   0.4547→0.3915 → 岛在画面里上移（岩尖 568→489px）、略微变小、可视横向变宽
   （858→996px）。文案块 top 72.7%→64%、行距 16/8/20→12/6/16。
   接缝的坑：取样带从**顶行**起铺会亮 28 级（实测 170→199）且对比度只剩一半 →
   必须**镜像起头**（第一行 = 原图最后一行）+ **逐行把均值/对比度重映射成原图
   趋势的延续**，接缝才降到 +1 级。脚本 `D:/tmp/isl-redesign/extend-footer.py`。
   → 必须跳版本：style.css 改了，且 **art/ 两张图的内容换了**
   （文件名没变、内容变了 —— 不跳版本的话浏览器和 SW 都会继续用旧图）。

   v103（2026-09-22）：**浮岛选岛页换成整幅生成插画**（`art/isle.webp` /
   `art/archipelago.webp`，各约 110 KB）—— 原来那版是 CSS 画的扁平淡绿椭圆 +
   棒棒糖树，加上一层薄荷绿渐变和一团冷蓝光，跟全站纯白 + 焦糖的身份完全打架
   （用户：「配色不好看，那两个岛屿也不是很美观」）。
   同时撤掉岛名下面的「1v1 / 1vN」小徽章，进岛从「点整页」改成明确的一个
   「进 岛」按钮；第二层存档列表页那层薄荷绿→蓝的渐变也一起改成暖白。
   顶栏在这页要彻底隐形：默认的 `.app-head` 是玻璃（`backdrop-filter:blur(14px)`
   + `::after` 一条渐变细线），压在插画上会糊掉最上面一条天空、还横着一道分界线。
   → 必须跳版本：style.css / page-island.js 都改了，**而且新增了 art/ 两张图**
   （它们走运行时缓存，第一次进选岛页才会落盘）。

   v15（2026-09-21 第 14 批）：图片出 localStorage —— ①群头像改存图库
   （IndexedDB 的 mediaId，老 dataURL 首次显示时自动搬家）；②头像 /
   faceLockImage 之外的三处头像字段都能选本地图了（avatarFieldLocal），
   显示统一走 core.avatarSrc/setAvatarBg/setAvatarImg（本地图优先）；
   ③聊天流式输出不再每个 delta 整页重画（只更新 pending 气泡那一个
   .msg-text，长对话不再接近 O(n²)）；④密码叙事化：[手机] lock/set ——
   char 在剧情里自己设锁/改密码/去锁，旧密码进 pinHistory。
   → 必须跳版本：core.js / phone.js / prompt-engine.js / 多个 page-*.js 都改了。

   v9（2026-09-21 第 6 批）：大号按岛（2026-09-21 拍板：没有全局大号，想玩
   同一个人设就是新建一个新的人）—— 新建大号一律打当前岛的章；拆岛连岛上的
   人一起清；「移出岛」保留本体但摘掉岛的章；导入人设不再同名覆盖、导入即
   打目标岛的章；删岛确认换成 v2 抽屉（列清楚要没掉的是什么 + 提示可以先
   移出单个人）；upsertUser 新建分支补丢掉的 city/region/timezone。
   → 必须跳版本：core.js / page-idcard.js / page-island.js 都改了。

   v8（2026-09-21 第 5 批）：查手机两条 —— ①「他设没设锁屏密码」在数据层立起来了
   （`lock.enabled`，默认没设；角色设置里一个开关），没设密码的锁屏不再出现任何
   输密码入口，但仍然建会话留痕；②失败提示统一走 `api.describeError`
   （以前 7 处写 `res.message || '请求失败'`，而 requestOnce 根本没有 message 字段，
   所以超时 / HTTP 401 / 没填模型 / CORS 全被吞成同一句）；补上 phoneRawFail 的
   重试入口；「轻量 / 丰富底片」两档提示词以前一样，现在真的分开了。

   v7（2026-09-21 第 4 批）：会话列表照微信改（预览不带「对方回：/你说：」、
   只显示最后一句、时间挪到最右上角；`previewOf` 改走 splitBubblesT，
   顺手把 [译]…[/译] 标签剥掉）；聊天页只留一层滚动（.page 不再和 .msg-wrap
   抢，点内容不再往上弹）；气泡最大宽度 82% → 90%；输入区改成
   「加号 / 输入框（表情按钮挪进框里）/ 发送」一行。
   → 必须跳版本：老用户装到的主屏应用会一直用缓存里那份旧 style.css / page-chat.js。

   v6（2026-09-21 第 3 批）：聊天页的长按菜单从「整宽底部动作表」改成
   **贴着被长按气泡的锚点浮层**；引用 / 编辑 / 复制 / 收藏 全部改成只作用于
   **被点中的那一个气泡**（以前都取整轮的 `a || b || c` 串）；新增左滑引用；
   编辑框改多行 + 宽版；多选的勾只挂在每条消息的第一个气泡上；
   气泡改按内容收缩（助手气泡以前被 stretch 拉到 82% 宽）。
   → 必须跳版本：老用户装到的主屏应用会一直用缓存里那份旧 style.css / page-chat.js。

   v5（2026-09-21 第 2 批）：模型选择器从「平铺进页面」改成**锚点浮层**
   （框内自己滚 + 顶部搜索 + 选完即收），四处重复实现收敛成一个
   `ui.modelPicker` / `ui.modelPickButton`；新增 `.anchor-pop` 系列样式。
   → 必须跳版本：老用户装到的主屏应用会一直用缓存里那份旧 style.css / ui.js。

   v4（2026-09-21）：修「对话设置整页崩」「副 API 存不了」「工坊按钮没反应」
   等一批渲染 bug；聊天列表加了头像、删除改成点按变长按；PWA 图标重画
   （去掉了烤进去的圆角，manifest 主题色跟着纯白底走）。

   同时修了两个**只在弱网/已装主屏时才暴露**的坑（用户报「手机加到首页点开
   报 ERR_FAILED」时排查出来的）：
   1) 缓存兜底可能 resolve 成 undefined —— respondWith(undefined) 在 Chromium
      里就是 ERR_FAILED，页面一片空白且我们这边毫无报错。改成三级兜底：
      index.html → './' → 自带的离线页（`offlineShell()`）。
   2) install 用 addAll 是「全成功才算成功」，弱网挂一个文件就整个装不上，
      这台设备直接没有离线壳。改成逐个 add、单个失败不拦安装。
   3) **只靠运行时缓存时，离线可用要等到第二次打开才成立** —— 首次访问时
      SW 还没接管页面，页面自己发的脚本请求它一个都存不下。断网重载的结果
      是「有壳没 app」（顶部时间和底栏在、界面全空）。加 warmShell()：
      install 期读 index.html、正则出全部本地资源主动灌缓存。
   → 必须跳版本：图标和 manifest 被缓存住的话，主屏上还是旧图标旧配色。

   v3（2026-09-18）：第 2 屏接上亚克力挂件灯，新增 vendor/（three + 灯核心）。
   它**不写进 CORE**：671 KB 的引擎塞进安装期预缓存，会让第一次装 SW
   白等好几秒，而灯在第 2 屏 —— 很多人一轮都不一定滑过去。
   交给下面那条「第一个请求谁就存谁」的运行时缓存，第一次滑到第 2 屏时再落盘，
   之后离线也能点亮。

   v2（2026-09-17）：配色整体换成纯白 + 玻璃，视觉全表重写。
   版本号必须跟着跳 —— 不跳的话老用户装到的主屏应用会一直用
   缓存里那份旧 style.css，看到的是上一版米白皮肤。

   v124（2026-09-28）：We 三页导航（we-tabbar：首页 / 时光 / 收藏馆 + ＋
   新增动作）与时光页 v1（page-we.js 新增 'we-time' 聚合页、
   page-collection.js 门厅挂 bar、app.js replace 走 replaceState）。
   → 必须跳版本：老用户缓存里的 page-we.js / style.css / app.js 都变了。
   ============================================================ */
'use strict';

var CACHE = 'sleepy-v166';
var CORE = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* 逐个 add，**不要用 addAll**：addAll 是「全部成功才算成功」，
         弱网下只要挂掉其中任意一个，整个 install 就 reject → SW 停在
         redundant，结果是这台设备上根本没有可用的离线壳（下次弱网打开
         就是白屏）。逐个来的话，缺哪个下次运行时缓存再补。
         2026-09-21 排查「PWA 点开 ERR_FAILED / 打不开」时改的。 */
      return Promise.all(CORE.map(function (u) {
        return c.add(u)['catch'](function () { /* 单个失败不拦整个安装 */ });
      })).then(function () { return warmShell(c); });
    }).then(function () { return self.skipWaiting(); })
  );
});

/* 把整壳（index.html 引用的全部 js/css/图标）主动灌进缓存。
   ⚠️ 为什么必须有这一步：**首次访问时 SW 还没控制这个页面**，
   页面自己发的那些 `<script src="page-*.js">` 请求根本不经过 fetch 处理函数
   —— 一个都缓存不上。所以「装完第一次打开之后整个 App 就能离线跑」
   其实是**假的**：离线重载只有 index.html 能从缓存出来，六十多个脚本
   全挂，界面上剩下一个空壳（顶部时间和底栏）。
   2026-09-21 用真机 + 断网实测抓到的（断网重载：有壳没 app）。
   做法：现场读 index.html 的文本、正则出全部本地资源逐个塞缓存 ——
   而不是在代码里写死一份清单（脚本列表一直在长，写死迟早漏）。
   第二次下载基本都命中 HTTP 缓存，所以代价很小。 */
function warmShell(c) {
  return fetch('./index.html', { cache: 'no-store' }).then(function (r) {
    if (!r || !r.ok) return null;
    c.put('./index.html', r.clone());
    return r.text();
  }).then(function (html) {
    if (!html) return null;
    var urls = [];
    var re = /(?:src|href)="(\.?\/?[^":?]+?\.(?:js|css|png|json))"/g;
    var m;
    while ((m = re.exec(html))) {
      var u = m[1];
      if (/^(https?:)?\/\//i.test(u)) continue;      /* 外站不管 */
      urls.push(u.charAt(0) === '.' ? u : './' + u);
    }
    return Promise.all(urls.map(function (u) {
      return c.match(u).then(function (hit) {
        if (hit) return null;
        return fetch(u).then(function (rr) {
          if (rr && rr.ok) return c.put(u, rr.clone());
        })['catch'](function () { /* 单个失败不拦 */ });
      });
    }));
  })['catch'](function () { /* 联网失败就算了，交给运行时缓存 */ });
}

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  /* 只管自己家 —— 接口请求（聊天/生图打给外站的）一律放行直连 */
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        /* 后台悄悄更新一份（stale-while-revalidate），下次打开就是新的 */
        fetch(req).then(function (r) {
          if (r && r.ok) caches.open(CACHE).then(function (c) { c.put(req, r); });
        })['catch'](function () { /* 离线就算了 */ });
        return hit;
      }
      return fetch(req).then(function (r) {
        if (r && r.ok) {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return r;
      })['catch'](function () {
        /* 完全没缓存又离线：导航请求兜底回外壳页。
           ⚠️ 这里**绝不能 resolve 成 undefined** —— respondWith(undefined)
           在 Chromium 里就是 ERR_FAILED，用户看到的是「嗯…无法访问此页面」
           加一个错误码，而我们这边什么都没报错，极难定位。
           2026-09-21 就是踩在这上面：手机上加到首页的 PWA 点开 ERR_FAILED。
           所以做三级兜底：index.html → './' → 一张自带的离线页。 */
        if (req.mode === 'navigate') {
          return caches.match('./index.html')
            .then(function (r) { return r || caches.match('./'); })
            .then(function (r) { return r || offlineShell(); });
        }
        return Response.error();
      });
    })
  );
});

/* 彻底没缓存又连不上时的兜底页。自带文案、不依赖网络 ——
   有它就不会再出现 respondWith(undefined) → ERR_FAILED 那种一片空白，
   用户至少知道「是网络，不是 app 坏了」。 */
function offlineShell() {
  var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Sleepy</title></head>' +
    '<body style="margin:0;display:flex;min-height:100vh;align-items:center;' +
    'justify-content:center;background:#FFFFFF;color:#43382C;' +
    'font:15px/1.7 system-ui,sans-serif;text-align:center">' +
    '<div style="padding:32px">' +
    '<p style="font-size:17px;margin:0 0 10px">连不上，本地也还没有缓存</p>' +
    '<p style="margin:0;color:#8A7A67">第一次打开需要联网。' +
    '加载过一次之后，再到桌面打开就能离线用了。</p>' +
    '<p style="margin:16px 0 0;color:#8A7A67"><button ' +
    'onclick="location.reload()" style="font:inherit;color:#8A6844;' +
    'background:none;border:0;border-bottom:1px solid currentColor;' +
    'padding:0 0 1px;cursor:pointer">再试一次</button></p>' +
    '</div></body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
