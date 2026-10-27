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

   v203（2026-10-07）：**群声 Batch A+B 接入批**——
   · 新增 forum-core.js（数据层）/ forum-gen.js（内容生成层）/
     page-qunsheng.js（App，6 页）；index.html 加载列表 +2；
   · page-desktop：第三屏贴纸空壳格换「群声」真入口，LAYOUT_VERSION 22；
   · store.js：forum 系列 13 键 + 2 映射键；core.js：删岛清理登记；
   · page-guide：两处桌面文案修正。
   → 必须跳版本：index.html / forum-*.js / page-qunsheng.js /
     page-desktop.js / store.js / core.js / page-guide.js 都变了。

   v202（2026-10-07）：**去冗余文案批**——
   · page-presets：条目下面那行解释（pp-row-hint）全部去掉 —— 调用类型的
     「F1 · 已实装」等、注入序列的槽位说明 / 「Sleepy 内置注入」、
     调试预览的「逐槽 tokens + 完整 prompt」。自定义注入行的 token 数不是
     解释，挪到右侧标签位（与两个序列区一致），没丢信息；
   · page-imggen：「视觉层（正式生图）」组内说明文字全去掉 —— 自定义框
     hint、随档位变的动态提示（内置档「内置词暂不提供编辑…」等三句）、
     NAI 那段「NAI 接口沿用其原生图路径…」。组标题说明按用户口径保留；
     字段、显隐逻辑、出站内容一字未动；
   · scripts/browser-e2-formal-style-test.js + browser-e2-v2-revamp-test.js：
     断言上述文案的用例改成**反向断言**（钉住别再长回来）；「空 custom 提示」
     那条换成真功能判据（落库为空 + 档位不弹回内置）；
   · browser-tts-preset-test.js：预设页快照加 rowHints 计数（应为 0）。
   → 必须跳版本：page-presets.js / page-imggen.js 变了。

   v201（2026-10-07）：**用户四点收尾批**——
   · page-presets：内置上锁卡点不进二级页（openCard 统一拦 + toast）；
   · page-chat：表情回应改按气泡段贴（reactions 存储升级为
     { segKey: { emoji: [maskId] } }，旧数据读取时归一化到第一段）；
   · tts.js + page-tts：新增「拉取模型列表」（custom_openai 走 OpenAI
     兼容 /models，Bearer）+ 拉到的模型下拉选、选中即落库；
     撤掉「全都是浏览器直连…」残留说明；
   → 必须跳版本：page-presets.js / page-chat.js / tts.js / page-tts.js 都变了。

   v200（2026-10-07）：**长按手感（五批遗留第 4 条）**——
   · page-chat：bindLongPress 按住期间气泡压暗（.lp-pressing）、触发瞬间
     navigator.vibrate(10) 微震动（iOS Safari 无 vibrate，静默跳过）；
   · ui.js + style.css：anchorPopover 支持 opt.arrow —— 面板带一枚小角
     指向锚点（微信长按菜单那种），水平位置 place() 算好写 --ap-x，
     .is-up 时角翻到底边朝下；消息长按菜单和撤回灰字条浮层已接 arrow；
   → 必须跳版本：page-chat.js / ui.js / style.css 都变了。

   v199（2026-10-07）：**五处手感/功能批**——
   · page-chat：长按贴表情 ReferenceError（`core is not defined`）修复，
     chat-detail render 闭包补 `var core` 声明；
   · tts.js + page-tts：接不了的「还不能直连」清单整组撤掉（含阿里云），
     模型选择搬进各服务的连接详情页（存到连接上），
     自定义服务的「模型 ID」此前从不落盘也一并修掉；
   · media.js + page-backup：新增「导出/导入媒体数据」（图库图片/语音本体
     整包 .json，dataURL 承载）；
   · prompt-engine：内置预设全部上锁——开发者模式出厂改为关，
     旧存档里的 dev:true 一次性洗成 false（设置页 5 连点可再开）；
   → 必须跳版本：page-chat.js / tts.js / page-tts.js / media.js /
     page-backup.js / prompt-engine.js 都变了。

   v198（2026-10-07）：**退出 app 后桌面点不动（隐形玻璃盖）**——
   · style.css：.page 转场改纯淡入后（a5e9c29），退场页停留在 opacity:0
     但仍铺满全屏、可命中，挡住桌面全部点击。补 visibility:hidden +
     pointer-events:none 默认态，is-active/is-behind 恢复；visibility
     挂 transition 延迟 0.26s，淡出动画播完才真正隐藏。
   → 必须跳版本：style.css 变了。

   v168（2026-10-05）：**relation.intent 接主动消息候选合成**——
   · page-proactive：candidatesFor 接 relationIntent:<rootId> 的 nextAction
     为候选（排在 attention/loop/unspoken 之后）；evaluate 加 [RELATION_INTENT]
     状态块（currentReading/direction/pace/requiredSignal/avoid）。
     校验：validUntil 可解析且过期 → 整块不取（缺失/不可解析不误杀）；
     重复沿用「来源:内容指纹」+ handled；剧透保护字段只进主动消息 prompt。
   → 必须跳版本：page-proactive.js 变了。

   v167（2026-10-05）：**总结卡三字段丢失链接上（relation/review/uncertain）**——
   · page-summary：ingest 不再因 changes 为空提前结束；relation.confirmedChange
     → relationship_fact 恒 pending（强制 user 确认闸，模型自称的共识不静默生效）；
     relation.intent（+currentReading）→ relationIntent:<rootId> 整块替换
     （剧透保护字段只落库，主动消息接线另批）；review/uncertain →
     reviewLog/uncertainLog:<rootId> 诊断日志（capped 10 次，不进 prompt/UI）。
   → 必须跳版本：page-summary.js 变了。

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

/* v169（2026-10-05）：**桌面第 3 屏空壳 + 群聊美化 + 设置页 MCP 位**——
   · page-desktop：版本 19 —— 第 3 屏贴纸/钱包/组件商城改 type 'blank'
     （空玻璃壳，无图标无跳转，功能都有别的入口）；ta 图标重画（拱窗 + 心）。
   · style.css：负一屏网格 align-content center→end（用户「整体下移一些，
     下面太空」）；.w-blank / .gd-beautify 新样式。
   · page-group + core-group：群详情「发起多人线下」卡改「群聊美化」
     （beautifyCss 白名单字段 + group-beautify 编辑页 + group-chat 注入，
     复用 apCustomStyle 槽位和角色外观互斥）。
   · page-settings：删「外观与文字/主题与字号」（外观里已有），原位放 MCP 行占位。
   → 必须跳版本：page-desktop.js / page-group.js / page-settings.js /
     core-group.js / style.css 都变了。 */
/* v170（2026-10-06）：**负一屏真沉底 + 相册整理 + 删照片连库清**——
   · style.css：负一屏下移的真正修法 —— .dt-grid 高度是内容自适应，
     align-content 全是无操作（两次栽坑教训写在注释里）；改 .dt-screen.is-neg1
     为 flex column + .dt-grid margin-top:auto（内容装不下自动回退不裁切）。
   · page-gallery + style.css：删右下角 .gal-fab 悬浮加号（顶栏已有入口）。
   · photos + page-chat：聊天里删照片消息（长按/多选 → dropMessages）时，
     相册记录按 mediaId 一并清（photos.removeByMedia），无其他引用连 IDB 本体删。
   · page-group：群聊美化编辑页加「复制 CSS 变量」按钮（execCommand 兜底，
     局域网 http 无 clipboard API）。
   → 必须跳版本：style.css / page-gallery.js / photos.js / page-chat.js /
     page-group.js / page-desktop.js（注释）都变了。 */
/* v171（2026-10-06）：**相册按账号隔离 + MCP 全量（连接层/设置/对话开关/工具循环）**——
   · photos：add 加 ownerCharId 归属章（显式 owner 优先，默认 activeCharOnIsland）；
     page-gallery 群岛先选人、按人过滤，「没记归属」的老照片单独一截；
     page-desktop 照片墙跟着当前角色走；page-chat 生成图归属对话角色。
   · mcp.js（新模块）：SSE / streamable HTTP 双 transport，initialize 握手 +
     tools/list + tools/call；多服务、总开关、逐工具开关（新工具默认关）。
   · page-settings：MCP 连接页（列表/表单/刷新工具/逐工具开关/删除）；
     page-chat-settings：对话级「MCP 工具」开关（chat.mcpTools）；
     page-chat：发消息时挂 ov.tools + ov.toolCall；
     api.js：bodyFor 带 tools/tool_choice，requestToolLoop（≤6 轮，role:tool 回填，
     带工具强制非流式）。
   → 必须跳版本：mcp.js（新）/ photos.js / page-gallery.js / page-desktop.js /
     page-chat.js / page-chat-settings.js / page-settings.js / api.js / index.html 都变了。 */
/* v172（2026-10-06）：**负一屏微调回「从第二行开始」**——
   沉底版（v170）用户看了报「太靠下了」；margin-top:auto 改成
   固定留一行（--dt-cell + --dt-gap），照片墙从第二行开始摆。
   → 必须跳版本：style.css / page-desktop.js（注释）变了。 */
/* v173（2026-10-06）：**链接卡解析接活 + 搜一搜 + 天气与搜索**——
   page-chat：链接卡元数据改三路（微博分享文案本地剥正文 / apizero 解析
   接口直连 / 旧路兜底），加号面板新增「搜一搜」跳转式搜索；
   core：weblink 配置层（源表唯一实现）；page-settings：天气与搜索 /
   视频解析两个子页接上；style.css：.search-jump-input。
   → 必须跳版本：page-chat.js / core.js / page-settings.js / style.css 都变了。 */
/* v174（2026-10-06）：**方向修正——搜索/天气是让 char 感知，不是给 user 用**——
   core：realworld 感知模块（Open-Meteo 免 key 天气 + news.orz.ai 免鉴权热榜，
   poke 预取 / compile 同步读），weblink 收缩成纯配置读写（源表撤销：
   实测免鉴权开 CORS 的通用搜索源为零，char 搜索能力走 MCP 工具）；
   prompt-engine：ONLINE_SLOTS 新增 realworld 槽（I02b，time 之后）；
   page-chat：删搜一搜（plus 项/跳转面板），requestReply 预取链加 poke，
   链接卡解析加 24h 缓存；page-settings：感知开关/城市/热榜子开关，
   style.css 删 .search-jump-input。
   → 必须跳版本：core.js / prompt-engine.js / page-chat.js / page-settings.js /
     style.css 都变了。 */
/* v175（2026-10-06）：**感知只留天气，换 OpenWeatherMap**——
   core：realworld 撤掉热榜路（用户裁决：热点思路不是我们的，也不注入），
   天气改 api.openweathermap.org（CORS 全开实测；key 存 weblinkCfg.owmKey）；
   page-settings：设置页精简（删成段解释），保存按钮收进卡片 btn-row，
   视频/天气两页加「注册页」跳转。
   → 必须跳版本：core.js / prompt-engine.js（注记）/ page-settings.js 都变了。 */
/* v176（2026-10-06）：**改名**——设置页「天气与搜索」→「天气感知」（里面早就没有搜索了），「视频解析」→「链接解析」（微博/抖音/B站链接卡不只视频）。→ 必须跳版本：page-settings.js 变了。 */
/* v177（2026-10-06）：**链接解析加自定义接口**——设置页可填自定义解析 URL 模板（{url} 占位，优先于 apizero），page-chat 解析链改「自定义→apizero→兜底」，保存时清解析缓存。→ 必须跳版本：page-chat.js / page-settings.js 变了。 */
/* v178（2026-10-06）：**私聊撤回**——①角色可撤回：模型输出 [撤回:N|原因] 协议标签（prompt-engine msgrecall 卡），程序打 recalledAt 不删原文；②user 可撤回：长按自己纯文字气泡 → 概率掷骰（角色设置页滑条，默认 40%）决定 TA 看不看得到内容，灰字条点击看原文/原因。→ 必须跳版本：page-chat.js / page-chat-settings.js / prompt-engine.js / style.css 都变了。 */
/* v179（2026-10-06）：**挂件灯色板换柔和浅色**——core 的 PALETTE 整表换成用户定稿 5 色（薄荷汽水/晨雾蓝/西柚苏打/燕麦暖白/雾灰香芋，tone 键名兼容），paintCard 磨砂层往白冲的量 0.93/0.80→0.72/0.58（新 fill 本身 L≈94%，再冲就洗成纯白）；源文件正式入库 vendor/lamp/（改源→node vendor/lamp/tools/build-core.cjs→覆盖 vendor core）。→ 必须跳版本：vendor/acrylic-lamp-core.js / page-desktop.js 都变了。 */
/* v180（2026-10-06）：**挂件灯亮度二轮（用户实测太暗）**——空卡当灯牌用，整张卡都是留白：①卡面留白暗底 rgba(22,17,28,.5)→rgba(88,92,110,.45)、板面渐变 alpha 0.24/0.28→0.62/0.66（往白冲 0.93→0.45/0.30，保色相又遮暗房间）；②印刷层底部压暗 -0.13→-0.06；③材质自发光 0.19→0.42、发光色暖橙 0xffd7a0→中性微暖 0xfff3e8（实测暖橙会把浅色卡全染成奶油色）。用无头浏览器截图自验两轮后再交付。→ 必须跳版本：vendor/acrylic-lamp-core.js 变了。 */
/* v181（2026-10-06）：**挂件灯留言批**——①store 登记 lampNotes（按岛隔离，core cleanupSandbox scoped 名单同步）；②page-desktop Sleepy.lampNotes.add（压平+40字上限+60条滚动），留言卡排空板前，onFocus 落款浮层 .w-lamp-sign（谁/何时），灯牌字体接外观 fontUrl（core 新增 font 选项+setFont）；③入口：私聊长按菜单「留在灯上」、群聊长按他人纯文字气泡直接留（署说话人名）、主动消息发送成功自动留灯。→ 必须跳版本：vendor/acrylic-lamp-core.js / page-desktop.js / page-chat.js / page-group.js / page-proactive.js / store.js / core.js / style.css 都变了。 */
/* v182（2026-10-06）：**灯牌 40 字规则进 proactive 卡**——主动消息 prompt 新增【灯牌】块：send 正文会被原样抄送灯牌（40 字小卡，超出截断不通知），请把正文控制在 40 字内。→ 必须跳版本：prompt-engine.js 变了。 */
/* v183（2026-10-06）：**灯牌改成 char 的常驻能力（不绑主动消息）**——引擎新增 lamptag 卡（C04）：[灯:那句话] 随时留灯、气泡不显示标签；page-chat 抽取管线 extractLampNotes（chatUtil 导出，冒烟单测）+ buildMessages 同文案 unshift；page-proactive 撤掉「主动消息全文自动上灯」，改为发送前抽 [灯:] 标签落库（标签必须在 addMessage 之前抽掉）。→ 必须跳版本：prompt-engine.js / page-chat.js / page-proactive.js / scripts/smoke.js 都变了。 */
/* v184（2026-10-06）：**组件商城橱窗批（施工卡批1）**——page-widgetstore 目录从列表行升级为橱窗预览卡（CSS 手绘 mini mock + hover 微浮起，@media(hover:hover) 防触屏粘滞）；卡上直连「加到桌面/在桌上×N/移除/再摆一件」，移除走 page-desktop 新导出的 rememberRemoved（同一笔账，「你删过的」原位装回不变）；App 入口拆独立分组只加不删。→ 必须跳版本：page-widgetstore.js / page-desktop.js / style.css 都变了。 */
/* v185（2026-10-06）：**灯设置面板（商城批2）**——store 登记 lampLight/lampFontUrl（此前 lampLight 只读无写入方）；page-desktop 新导出 Sleepy.lampCtl（lightGet/lightSet 热切灯色、fontGet/fontSet 灯牌专属字体 'SleepyLampFont' 独立 @font-face、notes.remove 单张删留言热刷新）；lampFontUrl 优先、回落外观 fontUrl（老行为不变）；widgetstore 灯卡加「设置」弹面板（灯光四档/字体直链/留言管理）。→ 必须跳版本：page-desktop.js / page-widgetstore.js / store.js / style.css 都变了。 */
/* v186（2026-10-06）：**简单砖组+拍立得（商城批3）**——page-desktop 新增 4 个 RENDER 类型：countdown（2×1，per-cell 配置存 store widgetCfg，ui.prompt 多字段设目标日）、weatherbrick（读 rwWeatherLast 快照 + 渲染时 poke 自带 30min TTL）、dateclock（15s tick，__cleanup 防定时器泄漏）、polaroid（2×2，手选相册照片最多 4 张，anchorPopover 选图器，srcOf 异步取图）；widgetstore EXTRA_DEFS 上架四件 + mini mock；smoke 新增「上架→应用→计数→移除记账→原位装回」全链路断言。→ 必须跳版本：page-desktop.js / page-widgetstore.js / store.js / style.css / scripts/smoke.js 都变了。 */
/* v187（2026-10-06）：**自定义组件+慢递信箱（商城批4）**——①自定义：store customWidgets（按岛隔离+删房清），page-desktop sanitizeTpl/scopeCss/substituteVars（变量白名单 time/date/weekday/weather/photo/lampNote/charName/todoCount/countdown:目标日；photo 走内存缓存异步取图），RENDER.custom（入库+渲染双次消毒、CSS 钉 .cust-<cellId> 作用域）；widgetstore 自制分组 + widgetmake 编辑器页（左模板右实时预览，size 1×1~4×6 自由）；②慢递：ability 卡 slowmail（[慢递:小时|内容]，1~72h），page-chat extractSlowmail+管线落 slowLetters、proactive 同口径（addMessage 前抽）、buildMessages unshift 说明书，RENDER.slowmail（未到点只显示在途时长绝不剧透）。smoke 新增慢递解析+消毒/作用域单测。→ 必须跳版本：store.js / core.js / prompt-engine.js / page-chat.js / page-proactive.js / page-desktop.js / page-widgetstore.js / style.css / scripts/smoke.js 都变了。 */
/* v189（2026-10-06）：**报错美化**——app.js 统一报错卡：①所有 toast(...,'err') 都走卡（含原来自行消失的丑胶囊）；②标题=明确原因（不再写死「出错了」），带稳定错误码 chip（NET/TIMEOUT/HTTP-404/CFG/PARSE/APP-XXXX，复制内容=[代码]原因+技术细节）；③scrubOwnUrl 补 127.0.0.1/localhost 本机调试地址（原只拦品牌域）；④报错卡永不自动关闭、右上角 × 关闭，普通 ok/warn 仍自动消失；加 --g-error/--g-error-dim 变量（亮色+夜灯珊瑚），重做 .is-card 玻璃卡视觉（标题色/错误码/圆形 ×/复制按钮）。→ 必须跳版本：app.js / style.css / scripts/smoke.js 都变了。 */
/* v188（2026-10-06）：**HTML 小游戏（char 发可玩网页）**——①prompt-engine 新增 htmlgame 卡（[html]…[/html] 多行块，说明书教模型写内联 CSS/JS 的整页小游戏）；page-chat extractHtmlGames 剥标签→commitHtmlGame 落 type:'html'（html 字段存源码），沙箱 iframe（htmlGameCard，sandbox=allow-scripts 不给 same-origin + CSP default-src none 堵出网 + SleepyGame.report 桥只认 registerGameFrame 登记窗口）；②结算：report 走 postMessage→noteGameResult 落 htmlGameResult:<chatId>（同局重复上报不覆盖、换局才更新），gameResultPeekMsg 下一轮把结算垫进上下文（读出即摘）；③删房清 htmlGameResult:<chatId> 幽灵键（同 charRel 动态键口径）；④重绘复用（缺口①）：htmlGameCard 按 msgId 缓存同一节点，renderMessages 每次 innerHTML='' 摘下、同对象 appendChild 回去不重载 iframe，玩到一半来新消息也不从头来，末尾 prune 失效条目。→ 必须跳版本：prompt-engine.js / page-chat.js / core.js / style.css / scripts/smoke.js 都变了。 */
/* v190（2026-10-06）：**小岛指南 App（使用说明手册）**——①新增 page-guide.js，注册 app 'guide'：按板块把现有功能（聊天/浮岛/世界书/日记/相册/日历/ta/We/外观/组件/工坊/预设/设置各 API…）整理成可滚动的说明书，条目带「在哪儿」+「打开›」可点跳对应 App；②桌面第 3 屏 (x3,y4) 那格从「钱包」空壳改成「小岛指南」真入口（p3-guide / type app / app guide），ICONS 加 guide 图标，LAYOUT_VERSION 19→20 强制迁移；③style.css 加手册页样式。→ 必须跳版本：page-guide.js（新）/ page-desktop.js / style.css / index.html 都变了。 */
/* v191（2026-10-06）：**四件事下线**——①桌面 6 个组件彻底移除（情绪印章 mood / 思念电量 battery / 时钟 clock / 双城时钟 worldclock / 正在播放 player / 农历日历组件 calendar）：RENDER 里的渲染函数 + style.css 对应 CSS + 孤儿函数（lunarText / cycleMood）+ 无消费者的 ICONS.mood/ICONS.clock 全清（**第 3 屏那个日历 App 不动**，它走 type:'app'）；②查手机里的相册 App 下线（一直只是空壳，无专属页面无专属数据表），PHONE_APPS 白名单 + 图标 + 文案 + phone.js 的 appOrder 全清；③面具轮盘（宇宙内就地切皮套）下线：page-switch.js 删 openWheel/getChatSafe/buildWheel/switchMask 整块 123 行 + switcher.wheel 导出 + page-chat.js 的死代码 chatDetailRefresh + style.css 的 .wh-* CSS（.sw-mask 是系统级切号器，只摘 .wh-mask 部分）；④删掉 smoke.js 里那条「禁止出现来源项目名」的护栏（新项目不该有这类来源禁令）。→ 必须跳版本：page-desktop.js / style.css / page-phone.js / phone.js / page-phone-ai.js / page-switch.js / page-chat.js / scripts/smoke.js 都变了。 */
/* v192（2026-10-06）：**小岛指南改折叠版（最小版）**——page-guide.js 重写：开篇常显 + 「第一次使用」默认展开 + 其余 10 个板块默认折叠（原生 <details>，箭头自绘）；内容块分 7 类（p / item / note / tag / li / step / qa），靠字体与颜色分层突出重点（功能名=深焦糖加粗，说明降一级，提示块=浅底+左边框，能力标记三色：本地/需要API/选配）。⚠️ 类名前缀从 .gd- 换成 .gz-（.gd- 是 page-group.js 群详情的前缀，会撞）。内容对齐 docs/文稿-小岛指南 定稿 v1。→ 必须跳版本：page-guide.js / style.css 都变了。 */
/* v193（2026-10-07）：**默认主题换奶蓝**——用户：「纯白不太好看了」「搭配的橙色不好看，马卡龙类会好看些，倾向蓝色的、透亮的柔和色调」。①style.css :root 主色系焦糖→奶蓝（accent #7CA8D6 / deep #5C86B4 / soft #C3DCF1 / pale #E4EEF9），字色暖深棕→冷墨（#2F3A47/#66768A/#94A3B4），底色纯白→奶蓝（base #F7FAFE / base-2 #F1F6FC / base-3 #E3EDF7），--g-pin-wash 跟着主色走，设置页织物纸转冷灰；②清掉 **144 处写死的 rgba(176,138,94,*) 焦糖**→rgba(124,168,214,*)，以及 #8A6844 兜底 / 音乐卡 / 照片墙纸带等暖色小件；③JS 里的硬编码同步：page-appearance 第一套改名「奶蓝」+ chip/bg/ink 全套换新、auto 壁纸预览、textColor 默认；page-workshop 模板默认色；phone ACCENTS 首色；splash --g-accent 兜底；sw.js 离线降级页。玻璃系统（--g-glass 系 / --tk 系 / --g-lens）本来就是冷灰蓝调，**未改动**。⚠️ 旧红线「不要蓝绿」已由用户澄清作废（禁的是廉价荧光绿，蓝与柔和蓝绿可用），:root 注释已更新。→ 必须跳版本：style.css / page-appearance.js / page-workshop.js / phone.js / splash.js / sw.js 都变了。 */
/* v194（2026-10-07）：**浮岛页保留暖杏色系（奶蓝主题的例外）**——用户：「浮岛页的进孤岛其实用原本的就可以，因为背景是杏色那种，用蓝色会比较突兀」。把 v193 里被批量换成奶蓝的浮岛专属色回退成暖杏：island 页的返回键/文字、isl-dot.is-on、进岛按钮底（#B08A5E / #8A6844）。⚠️ 只有 isl-* 与 island 页那两支享受这个例外；simple-form / simple-sub 是浮岛与名片夹共用类，跟随全局奶蓝。已在 style.css 该块顶部加注释锁住这个例外，别再当成漏改的旧焦糖统一掉。→ 必须跳版本：style.css 变了。 */
/* v195（2026-10-07）：**海盐换薄荷 + 小岛指南多色混搭**——①原 sea 主题（冷蓝）跟新的奶蓝默认撞色，用户同意改成马卡龙薄荷绿（accent #8AC9C3 / base #F3FBFA / 墨色同步转绿），data-theme 的 id 仍是 sea 不动（老存档里选过它的不能失效）；page-appearance 的 THEMES 预览色卡同步改名为「薄荷」。②小岛指南 12 个板块各配一支马卡龙色（SECTIONS 增加 c 字段，渲染时写进 --gz-c），标题/色点/箭头/功能名/步骤圆标/路径/列表 marker/提示块左边框/问答问句全部吃它；提示块底用 color-mix 兑到 12%（12 种色再给实底太吵）。→ 必须跳版本：style.css / page-guide.js / page-appearance.js 都变了。 */
/* v196（2026-10-07）：**手册目录统一色 + 主题 id sea 改 mint**——①用户看真机反馈：12 个板块标题各用一色显得花花绿绿，大目录统一成冷墨 var(--g-ink)，箭头回中性灰；板块马卡龙色只留在色点（折叠时的颜色线索）和展开后的内容里（功能名/步骤圆标/路径/提示块/问答问句不变）。②用户确认开发期没有外传用户，主题 id 也可以改：data-theme 的 sea 全部改名 mint（style.css 5 处选择器 + page-appearance THEMES 的 id），旧 sea 字样零残留。③顺手处理浏览器点击 summary 的金色 focus 框：outline:none + 只保留 :focus-visible 键盘可达。→ 必须跳版本：style.css / page-appearance.js 都变了。 */
/* v197（2026-10-07）：**第 3 屏外观格改空壳**——外观在主屏 p1-look 已有一份，第 3 屏 p3-look 是重复入口，用户要求改成空的占位（做法同版本 19 那批贴纸/组件商城）：type 改 blank，图标空、内容空、不跳转，app 字段保留以便一行接回，格子 id 沿用 p3-look。LAYOUT_VERSION 20→21 强制迁移；冒烟同步：空壳名单加 p3-look、补「主屏 p1-look 必须仍是 app」的保护、版本断言改 21。→ 必须跳版本：page-desktop.js / scripts/smoke.js 都变了。 */
/* v204（2026-10-07）：**用户协议 / 隐私政策（内测前第一件，发售路线 v1）**——①新增 legal.js：两份正文常量（用户协议 7 节 / 隐私政策 7 节）+ 首启弹窗（双标签切换、可滚动正文、「先看看」与「我已知情，不再提示」两个出口）+ 设置页「其他」组里两个随时可翻的入口。**「先看看」不写标记**（下次进来还会弹 —— 有意留的余地，别改成逼用户勾选）；点遮罩等同「先看看」。②store.js 新增 DEVICE_LOCAL_KEYS 判据：协议同意标记 legalAgreedAt 是**设备本地状态**，用户导出 / 内部回滚快照 / 用户导入**三个方向都不带** —— 否则换设备导入会带着上一台设备的「我已知情」直接进桌面、该弹的不弹（这是冒烟 L3 抓出来的真缺陷，不是测试写错）。它和 isProcessKey **分开单列**：过程数据要进内部快照，同意标记是两边都不进，混进去会让回滚口径失效。③真机验收（390×844 实拍）后修了四处：卡片底太透读不清 → 底色加实 + 遮罩提z-index 到 96；正文区被压到 204px → 按 dvh 重算高度 + 底部渐隐提示「下面还有」；两条按钮 flex 失衡 → 改成固定比例；**`frag.appendChild.apply(frag, out)` 只有第一个节点进去、其余静默丢** → 强调词一条都没渲染（页面看着却正常），改逐个 append，`emCount` 从 0 变成 9。另把正文里的 **强调片段改短**（长句加粗时背景色跨行断开像坏排版）。首启补上副标题。④首启弹窗挂在 splash.js 的 finish() 里**遮罩摘掉之后**触发，别盖在开屏动画上（盖上去用户会以为点不动）；legal.js 排在 ui.js / store.js 之后、splash.js 之前。④协议正文里**不许写绝对化承诺**（「永不上传」这类与可选备份矛盾的表述），冒烟 L4 用静态护栏拦住了。→ 必须跳版本：legal.js / store.js / splash.js / style.css / index.html / page-settings.js 都变了。 */
var CACHE = 'sleepy-v273';

/* v273（2026-10-27 深夜）：TA 换头像时**真的看图再挑** ——
   · page-chat.js：applyCharAvatarSwap 改异步（结果走回调）；新增
     pickAvatarBySight —— TA 没指名或名字没对上时，发一次多模态请求，
     把「对方的头像 + TA 库里每一张」给 TA 看，让它只回一个名字再落库。
     只在它自己起意要换的这一刻才调，不占每轮装配的 token；主 API 不是
     多模态 / 取图失败 / 回的话对不上 → 退回挑第一张，不卡流程。
   → 必须跳版本：page-chat.js 变了。 */

/* v272（2026-10-27 晚）：发视频 + 头像库 + char 自主换头像 ——
   · 新增 video-understand.js（视频读懂：抽帧改自适应「每秒 1 帧，夹到
     6~24 帧」+ 音轨抽 16k 单声道 WAV 送 input_audio；端点不认音频时
     自动降级重试一次只发画面）+ index.html 加载列表 +1；
   · page-chat.js：加号面板「发视频」（存图库 kind:'video'，100MB 硬闸 /
     50MB 软提醒）、消息 type:'video' 用 <video> 播放、attachText 把
     caption 带进上下文；新增 [换头像:名字]（extractAvatarSwaps /
     applyCharAvatarSwap，三道闸：开关 / 库非空 / 不是当前这张），
     换完落一条 type:'avatar-swap' 灰字；
   · page-idcard.js：新增 avatarLibField（每 char 一份头像库，
     avatarLib=[{id,label}]，点选设当前 / 右键改名 / 小叉删除）+
     faceField 补 setMedia 供外部设图；
   · page-char-appearance.js：外观页「TA 的自主权」开关（allowSelfAvatar，
     默认关；库是空的时候点开会拦一把，先去存图）；
   · prompt-engine.js：ONLINE_SLOTS 加 avatarswap 槽 + compileAvatarSwap
     （与 page-chat 旧路径双份同款；开关关着时两边都不注入）；
   · page-singleapi.js / page-settings.js：新增「视频理解 API」
     （singleApi kind:'video'，OpenAI 兼容，单份一页表单）；
   · style.css：.msg-video*（视频气泡）+ .av-lib*（头像库网格）。
   → 必须跳版本：上面这些运行时脚本全变了。 */

/* v271（2026-10-26 晚）：全屏 + 心声星瓶 ——
   · manifest.json：display_override 加 fullscreen（真机上系统状态栏那条
     和 App 自己画的 #statusbar 叠着，顶栏显得特别低；Android 认 fullscreen，
     系统栏消失 + safe-area 归零，名字栏自然上移；display 那行仍是
     standalone，认不了 display_override 的（iOS Safari）自动回落）；
   · page-desktop.js：新增心声星瓶渲染器 starbottle + 取数 islandWhispers
     （只收本岛角色对话里的 heartbeats）/ 瓶身 starBottleSvg / 飘星 starPop；
   · page-widgetstore.js：EXTRA_DEFS + MOCKS 上架（1×1 —— 默认户型只有
     第 6 行有空位，h=2 的格子装不下）；
   · style.css：.w-starbottle / .wsb-* + 商城缩样 .ws-mock--bottle。
   → 必须跳版本：manifest.json / page-desktop.js / page-widgetstore.js /
     style.css 都变了。 */
/* v270（2026-10-26）：聊天手感批 + 帷境滚动批 + 空回维稳 + 副API/演示岛补课 ——
   · prompt-engine.js：c05 输出协议放宽（气泡 1-3 句 ≤60 字）+ 情绪外化要求；
   · page-chat.js：流式回复拟真节奏上屏（新回复气泡逐条揭示 pendingReveal，
     reroll 走旧热路径）+ revSave 函数补定义（v261 漏了本体，点反查手机
     必炸 ReferenceError）+ 时间分隔线刚出现时藏气泡自身时间戳；
   · prompt-engine.js：splitBubblesT 加草稿漏出清洗（剥「4:」编号与
     「（24字）」字数标注）+ c05 加「不输出编号/字数标注/草稿」禁令；
   · wj-data.js：帷境时间落点新增「认识 user 之后」（after_user）；
   · page-wj-read.js：阅读进度落库改防抖（停稳 900ms + 挪段才写），
     修「帷境上下滑卡顿忽闪」；
   · api.js：空响应算失败换候选重试（流式/非流式两路）+
     GEN_DEFAULTS.maxTokens 1024→2048（reasoning 模型烧光 token 的空回）+
     FEATURES 新增 wjcurtain（帷境走副API）；
   · wj-engine.js / wj-canon.js / wj-coread.js：三处 transport 统一挂
     feature:'wjcurtain'（副API分配接线）；
   · demo-seed.js：小满功能笔记 8→10 条（新增帷境 / 桌游与入局两条，
     加号面板口径改 10 项）；
   · icons/：icon-192 / icon-512 透明底垫雾蓝 #A8BFD8（用户选色；改色一律
     从 git 原图垫底合成 —— 阈值替换会吃掉浅色幽灵，已踩）；
   · prompt-engine.js：旁白放宽可写在场 NPC + 线下 NPC 台词格式
     （「NPC名字：台词」写进叙述文本，npcFrequency 非 none 才注入）；
   · api.js + page-chat.js + page-chat-settings.js：Token 用量统计
     （askUsage → include_usage，接口不认自动降级；msg.usage 落库；
     对话设置→Token 用量 抽屉：全局开关 + 本对话账单）。
   → 必须跳版本：prompt-engine.js / page-chat.js / wj-data.js /
     page-wj-read.js / api.js / wj-*.js / demo-seed.js / icons/* 都变了。 */

/* v261（2026-10-25）：**反查手机上线**——TA 偷看你的手机（qs reverse* 移植）：
   revcheck-core.js（触发闸/倾向自动推导/权限/浏览计划，纯逻辑）+ page-chat.js
   接线（接管覆盖层：真页面导航 + 真滚动模拟 + 呼吸胶囊 + 内心想法弹幕 +
   采样器只读本岛 + 加号面板「反查手机」入口 + 主动触发挂回复轮次 + 收尾
   type:'revcheck' 播报 + eventNote 注入 + 记忆落库）+ style.css .rev-* +
   index.html 加载 revcheck-core.js。→ 必须跳版本：page-chat.js / style.css /
   index.html 变了，revcheck-core.js 新增。 */

/* v260（2026-10-25）：**文字麻将上线**——SullyOS「文字打马吊」1v1 移植到私聊：
   wm-core.js（引擎+牌库，纯逻辑零依赖）+ page-chat.js 接线（牌局状态挂 c.wm
   按对话存 / buildMessages 两路径每轮垫牌局上下文 / 回复链解析 WM 标签动牌
   并剥净 / 牌桌播报 type:'wm' 居中灰条 / 加号面板「文字麻将」入口 + 牌桌
   弹层）+ style.css .wm-* / .msg-wm-line + index.html 加载 wm-core.js。
   → 必须跳版本：page-chat.js / style.css / index.html 变了，wm-core.js 新增。 */

/* v259（2026-10-24）：**聊天气泡粉蓝半透明 + 轻量爪印 + 头像幽灵补漏**——
   用户口径：「只改聊天，不改桌面；我方藕粉、对方淡蓝、透明感重一些」。
   · page-char-appearance.js：COLORS 加 lotus 色板（accent #C5A0AE 藕粉 /
     ink #6B4552 / incoming #A8BFD8 雾蓝 / alpha 30 半透明），老色板无新字段
     走老公式（wash 混 --amber）行为不变；PRESETS.default.color 换 lotus；
     buildCss 半透明我方泡 + 对方淡蓝泡 + 细边；buildPageCss 爪印钮去实底。
   · style.css：2823 段气泡规则改藕粉/淡蓝半透明（与色板三值硬对齐）+ 去投影；
     .send-btn 无底爪印（--g-accent-deep，按压/忙碌 pale 底，删旧 #FFFDF9 覆盖）；
     夜灯下我方泡字翻浅藕粉；reaction 药丸同色系；死规则注释化保留。
   · page-chat.js：charAvatarEl/userAvatarEl 没头像落 v255 幽灵（同步铺幽灵
     占位、有图异步换），不再棕色圆点/首字圆。page-group.js tileEl 同。
   → 必须跳版本：page-char-appearance.js / style.css / page-chat.js /
     page-group.js / scripts/smoke.js 都变了。 */

/* v258（2026-10-24）：**授权服务多 base 故障转移 + 可读失败文案（A+B）**——
   诊断结论：校园网/iOA 对 *.workers.dev **定向封锁** —— DNS 投毒返回
   Facebook IP（face:b00c 段）+ TCP 静默丢包（实测 connect=0.000s 全超时；
   同网 cloudflare.com 解析正常 ⇒ 按域名清单封锁，不是墙整个 CF）。
   VPN 能通是因为隧道里 DNS 与流量都不经本地网关。
   · repo-core.js：DEFAULT_BASE → **DEFAULT_BASES 多 base 顺序故障转移**，
     **主位待填自定义域名**（CF 后台绑 Custom Domain 后只改这一个字面值；
     名单外域名，校园网可直连），workers.dev 降级兜底（VPN 用户/自定义
     域名临时故障）。repoBases() 去重（域名未填时两 base 相同，退化单发
     不傻等两遍）；repoCfg.base 覆盖通道升级为逗号分隔多入口。
     licRequest 重写：非最后 base 5s 短超时（AbortController 真取消，
     老浏览器 race 兜底）主动切下一个；全失败报统一文案
     LICENSE_NET_HINT（不再把 Failed to fetch 怼给用户）。
   · scripts/smoke.js：行为级断言（注入双 base 验证自动转移 + 全挂文案
     硬写基准）+ 静态护栏（结构在/老文案禁复活/去重）。
   → 必须跳版本：repo-core.js / scripts/smoke.js 都变了。 */

/* v257（2026-10-23 深夜）：**内测一键进门（临时通道）**——
   给激活闸的门面加一个「一键进门」：现场摇领取号 + 默认密码，拿公用激活码
   激活，不用先去发码页领码（内测期省事）。证凭共用、**身份各归各**：
   worker 那边 users.qq 的唯一索引一步没让（见 worker/repo-worker.js 的
   /account/activate），每个人仍是独占的一行 user —— 图省事改成共用一个 uid
   会同时踩「3 台名额互相挤」和「revoke/改密/注销互操作」两个坑。
   ⚠️ 这是**阶段产物**，整段下线清单写在 page-license.js 文件头的
   BETA 注释里（含云端那行 codes.status 置 0 —— 最关键的一处）。
   → 必须跳版本：page-license.js / style.css 都变了。 */

/* v256（2026-10-23 深夜）：**站内静态图片也进安装期预热**——
   warmShell() 以前只扫 index.html 的 src/href，而 core.js 里写死的默认
   头像（art/avatar-ghost-char.png / -user.png）是 JS 字符串里的相对路径，
   一张都捎不上：SW 装完立刻断网打开，头像位是空的（更早的两张 art/ webp
   也一样，从没被预热过，只是没人发现）。
   做法：二级扫描 —— 拿到 index.html 的 js / css 清单并存进之后，再从缓存
   读回文本，正则抽本地资源的图片（见 warmInlineAssets 的 AssetDirs）。
   越界目录不扫：vendor/three 这类库里有一堆对本壳没意义的资源名，扫了
   只换来一串 404。仍然不写死清单：往 art/ 丢张图并在 js/css 里引一句，
   下次安装自动进缓存，不用回头改 sw.js。
   → 必须跳版本：sw.js 变了。 */

/* v255（2026-10-23 深夜）：**默认幽灵头像** ——
   无头像的 char/user 不再回落「首字 + 暖色块」：core.js 的
   setAvatarBg / setAvatarImg 空值时落 art/ 的幽灵贴纸
   （char = 戴睡帽抱枕头，user = 打哈欠揉眼睛；AI 生成 + 绿幕抠图，
   水印和棋盘格假透明都清了），is-default-ava 类让首字隐身（style.css）。
   判别用 rec.kind（main/sub/npc = 角色），不看 id 前缀。
   → 必须跳版本：core.js / style.css 都变了，art/ 新增两张图。 */

/* v254（2026-10-23）：**授权闸接进启动链**——
   账密系统从「进去后在设置里补填」改成「进入 sleepy 的门槛」：
   · repo-core.js：license 段加 licenseGateState()（none / expired / ok，
     7 天离线宽限常量 LICENSE_GRACE_MS）；
   · page-license.js：激活/登录表单抽成 buildGuestForms 一份两用
     （设置页 + 启动闸），新增 Sleepy.licenseGate（state / mount）；
   · app.js：bootHome 挂桌面之前先过闸 —— 非 ok 画 licenseGate 到 home 位，
     过审 force() 重进；已过闸后台静默 licenseMe 刷宽限；
     补上一直缺失的 bootHome.force 真身（repaint 保底引用了但从没定义过）；
   · page-settings.js：授权行改「我的授权」（改密/设备/注销），hint 去版本号占位；
   · style.css：license-gate 门面样式。
   → 必须跳版本：app.js / repo-core.js / page-license.js / page-settings.js /
     style.css 都变了。 */

/* v253（2026-10-22 晚）：**workers 子域去 QQ 化**——
   账号子域 2383444931 → sleepy-goodluck（发码页/御膳房 API 两用的
   workers.dev 链接不再暴露 QQ 号；repo-core 的 DEFAULT_BASE 同步换，
   全库唯一烤点。旧子域已删，旧链接即刻失效——无外传用户，零成本）。
   → 必须跳版本：repo-core.js 都变了。 */

/* v252（2026-10-22）：**账密系统收口批（worker）**——
   · repo-worker：①发码页加营业口令闸 —— /issue/claim 必须带 key 且等于
     env.ISSUE_KEY（wrangler secret put ISSUE_KEY；没配 = 歇业 fail closed），
     堵「知道域名就能任意 QQ 白领码」；②会话空闲过期 —— sessionOf 只认
     last_seen 30 天内的会话，token 不再永久有效（活跃用户无感，/me 刷活）。
   · scripts/smoke.js：假 env 带 ISSUE_KEY；负向 ×3（无口令/错口令/空闲过期
     会话）；发码页静态断言补口令输入位。
   → 必须跳版本：worker/repo-worker.js / scripts/smoke.js 都变了。 */

/* v251（2026-10-22）：**入席单件（世界档案单独分享）**——
   · repo-core：cleanBookData/packBook/importBook —— 与整岛包 book 件同构
     （box+import），差异：岛章 sandboxId 不进包（导入重盖）、媒体引用
     （coverRef/sceneRefs）不进包、领取进当前激活岛且 status 归 empty
     （从零开局，进度/卷宗/物件不跟过来）。
   · page-repo：发布页类型 +「入席（单独分享一本世界档案）」（选当前岛
     的档案盒）；导入向导 book 分支进当前岛；fillSub 顺手修「上次选空
     残留禁用」带到别的类型。
   → 必须跳版本：repo-core.js / page-repo.js / scripts/smoke.js 都变了。 */

/* v250（2026-10-22）：**火候单件（预设单独分享）**——
   · repo-core：presetPayloadOf/packPreset/applyPresetPayload/importPreset ——
     载荷 fmt sleepy-preset-v1 只带 disabled/overrides/custom 三块最小集
     （卡 id/时间戳、引擎开关、开发者模式都不进包，导入重新发 id）；
     叠加 = 卡追加+关卡只增不减+覆盖逐槽盖；整套 = 三块全换；空包打包/导入双拒。
   · page-repo：发布页类型 +「火候（打包一套预设配置）」；导入向导二选
     （叠加 / 整套装上并明示会清掉自己原来的）。
   → 必须跳版本：repo-core.js / page-repo.js / scripts/smoke.js 都变了。 */

/* v249（2026-10-22）：**御膳房美化链路 P0 修复 + 摆盘单件**——
   · repo-core：美化件改最小载荷 fmt sleepy-theme-v1（配色+桌面三键；
     custom 壁纸引用本机媒体不进包→落 auto），packIsland 不再整档外观进包；
     applyThemePayload 导入只写目标岛覆盖（或全局），绝不冲领取者整档；
     新增 packTheme/importTheme/美化预设（repoThemes，设备级）；
   · page-repo：发布页加「摆盘（单独分享一套美化）」类型；导入向导
     整岛包美化选项改「应用到新岛（只动这座岛）」；摆盘单件三选
     （存预设/全局/当前岛）；
   · page-appearance：外观页新增「美化预设」组（应用=当前编辑目标，即时落档）。
   → 必须跳版本：repo-core.js / page-repo.js / page-appearance.js / index.html 都变了。 */

/* v248（2026-10-17）：**查手机群聊视图 + 分享回执·已回应 + 假绿修复批**
   （TODO 第二批收尾 + 假绿批）——
   · page-phone.js：群聊只读视图补完（此前 toast「下一批施工」）——
     openGroupChat（deepScroll 同私聊口径）/ paintGroupChat：气泡左右按
     **落库的 senderEntityId 对 ownerId** 判（渲染时不猜），发送者展示名走
     groupStore.accountMeta（与群聊本体页同一套，不长第二张脸），系统消息
     居中，撤回显示「撤回了一条消息」，只读 composer 照旧；
   · forum-share.js：+onConversationMessage —— 接收方在分享落地的会话里
     **开口**才给「回应了」回执（chat=role char / group=senderKind char|npc；
     user 自己说话不算；只认已打开的最近一条，一条只回执一次），
     通知走 notify 落到分享者；
   · page-chat.js addMessage / core-group.js addMessage：咽喉各挂一次
     onConversationMessage（try/catch 静默，forumShare 缺席不影响消息本身）；
   · scripts/smoke.js：假绿修复——三处 `alt[0] || mainA` 退化型 fallback
     （1944/2379/2429）改硬断言第二个身份存在（user 2026-10-17 点名）；
     +2 回归（查手机群聊视图静态护栏含反向断言「占位 toast 不许回来」 /
     已回应回执四断言）。
   → 必须跳版本：page-phone.js / forum-share.js / page-chat.js /
     core-group.js / scripts/smoke.js 都变了。 */

/* v247（2026-10-17）：**板块级催更批**（user：每个板块能不能单独刷新）——
   现状核查：帖子级刷新已有（详情页「催一下」→ requestReplies，带 60s
   冷却与「只看楼主」过滤），缺的是板块级。
   · forum-gen.js：+genBoard(sandboxId, boardId, cb) —— 只给指定板块生成
     1~3 帖：提示词带板块名/简介/**版规**，帖内容贴题；board 强制成该板块
     模板键（模型越权指别板块也不听）；events 不生成（全岛风景归 genMore）；
     60s 冷却按板块记（lastBoardAt，与全岛 genMore 分开）；复用 writeSeed 落库；
   · page-qunsheng.js：板块页统计条下挂「催一下 —— 只让这个板块热闹起来」
     （qs-poke 同款，冷却 toast 口径同详情页）；空板块文案同步改指向本按钮；
   · scripts/smoke.js：+genBoard 回归（只落指定板块 / 越权指板块不听 /
     60s 冷却，transport stub 故意越权验证强制归位）。
   → 必须跳版本：forum-gen.js / page-qunsheng.js / scripts/smoke.js 都变了。 */

/* v246（2026-10-17）：**今日风闻真事件流批**（TODO 第二批 B4）——
   · forum-core.js：+listWorldEvents/addWorldEvents —— 岛级小事件流，
     存 forumSettingsBySandbox[sid].worldEvents（映射键本来就走删房清理，
     **不另开表**省三处登记、避开删房名单差集老坑）；环形封顶 40 条新在前，
     文本 ≤40 字、同文去重（催更不重播旧闻）；
   · forum-gen.js：种子/催更的 JSON 协议加 events 字段（2~4 条 / 1~3 条
     岛上小风闻，≤30 字、有生活气、不复述帖子）—— writeSeed 顺路入池；
     **修了一个真 bug**：ensureSeedContent 落 seeded 标记时整对象覆写
     设置映射，会把 writeSeed 刚写的 worldEvents 静默抹掉 → 改合并写；
   · page-qunsheng.js：首页「今日风闻」改吃真事件流（最新一条 + 时间），
     无事件回落最新一帖，再没有才显示安静文案；
   · scripts/smoke.js：+世界事件回归（种子生成数 / 新在前 / 截断 / 封顶
     挤最旧 / 孤儿岛回落空数组）。
   → 必须跳版本：forum-core.js / forum-gen.js / page-qunsheng.js /
     scripts/smoke.js 都变了。 */

/* v245（2026-10-17）：**群声可见性 + 版规 + 今日话题批**（TODO 第二批前半）——
   · forum-core.js：+visibleToViewer / getHomeFeed 加第 5 参 viewerAccountId
     ——「仅关注者」（visibility:'followers'）的帖在 feed 层就过滤：
     作者本人放行、关注了作者放行、无视角一律不看（不静默泄露）；
     BOARD_TEMPLATES 八板块各配正式版规 rules（文案硬写，跨岛复用）；
   · page-qunsheng.js：发帖页加「可见范围」行（公开/仅关注者，复用 qs-type）；
     卡片与详情挂「仅关注者」标签；详情页对非关注者（非作者）直接 errBox
     「这篇只给关注的人看」；首页三处 getHomeFeed（首屏/翻页/今日风闻）
     全部带观看者视角；泡泡糖加「今日话题」（确定性选题池 16 条，
     同岛同日恒同一题，零模型零网络，导出 Sleepy.qsTodayTopic 供冒烟）；
     板块页版规卡按模板键回落显示 rules（老岛 board 落库无此字段，免迁移）；
   · 转发复检零改动：buildPayload/checkOpen 本来就拒非 public（no-perm）；
   · scripts/smoke.js：+2（仅关注者四视角断言+转发拒绝+公开帖不受影响 /
     八板块版规全配+今日话题稳定）。
   → 必须跳版本：forum-core.js / page-qunsheng.js / scripts/smoke.js 都变了。 */

/* v244（2026-10-17）：**群声无限滚动 + 作者删帖批**（TODO 第一批，见
   docs/待办-未完成功能.md）——
   · page-qunsheng.js：首页 feed 无限滚动——首屏 12 条，滚近底部按游标
     着页追加（追加不动已有卡片，不整页重绘不闪不丢滚动位）；占位行
     「下一批接入无限滚动」删除；详情页「更多」死钮换成作者操作面板
     （软删 + ui.confirm 二次确认，删后返回；**非作者整颗不渲染**——
     举报没有基础设施，不放假的钮）；
   · forum-core.js：+deleteOwnPost（作者软删 status:'deleted'，身份即权限）；
   · forum-gen.js：requestReplies 拦 status!=='active'（删帖后 4s 迟到的
     回应队列不再给死帖生成内容）；
   · page-ta.js / page-group-offline.js / page-qunsheng.js：过期注释清理
     （提案已上线 / 群线下结算已接线 / Batch C+D 已交付）；
   · scripts/smoke.js：+删帖三断言（作者可删/非作者拒/feed 消失+队列拦截）
     +游标分页回归（翻页不重不漏、新在前）。
   → 必须跳版本：forum-core.js / forum-gen.js / page-qunsheng.js /
     page-ta.js / page-group-offline.js / scripts/smoke.js 都变了。 */

/* v243（2026-10-16）：**设置 App 按钮统一批**（user：向量记忆的保存/测试连接
   和主 API 长得不一样，设置里好几个这样）——
   · page-singleapi.js：向量记忆 API 页此前误用了下载页那套 dl-btn 灰按钮
     （ui.button 的 kind 参数被塞了 CSS 类名，全设置 App 仅此一处）——
     保存/测试连接/清空 + 向量工具区（重建/现在扫一遍/找找看/清掉×2）全部
     换回标准 btn 系列（ghost/primary/danger），容器 dl-actions → btn-row，
     顺序对齐主 API（测试连接在前、保存在后）；顶栏补上「保存」动作
     （主 API / 总结编辑页都有，就它没有）；
   · page-tts.js + style.css：TTS 账户连接的 API Key「显示」小钮从裸文字钮
     tts-mini-btn 换成全 App 密码框统一的 set-eye，死 CSS 一并清掉；
   · 其余设置子页（主 API/副 API/TTS/生图/备份/MCP/网页解析）核查过都是
     标准按钮，未动；dl-btn 在贴纸/群等别处的对话框里是另一套视觉家族，不动。
   → 必须跳版本：page-singleapi.js / page-tts.js / style.css 都变了。 */

/* v242（2026-10-16）：**群声轻量地点批**（user 拍板：不定位现实，纯文字标签）——
   · forum-core.js：placeText 收口（trim + ≤20 字，字段本就在 createPost 里）；
   · page-qunsheng.js：「+ 地点」真接入 —— 点击展开输入行（输入不 rebuild
     保焦点，收起即清防看不见的旧地点）；详情页「📍 地点」行；信息流卡片地点标签；
   · forum-gen.js：回应感知地点（replyMessages/voteMessages 带「发帖地点」行，
     NPC 吐槽说得出在哪儿）；催更新帖可自带 place 字段（writeSeed 收口）；
   · forum-share.js：describeForModel 带「发帖地点」行；
   · scripts/smoke.js：+2 回归（placeText 收口+转发票况带地点 / 催新帖 place 落库）。
   → 必须跳版本：forum-core.js / page-qunsheng.js / forum-gen.js /
     forum-share.js / scripts/smoke.js 都变了。 */

/* v241（2026-10-16）：**群声投票批（v240 后续）**——
   · forum-core.js：createPost 收 vote（2~6 选项去重 ≤24 字，发出即锁定，
     不进 POST_UPDATABLE）；+castVote（一人一票，改投/撤票=同键再点）
     / voteSummary（公开层只给显示名，绝不露账号 id）/ myVoteOf；
     **票随帖走**（post.vote.votes 内联）——不另开表 = 不进删房名单差集的老坑；
   · forum-gen.js：+voteMessages/applyVotes —— 投票帖走「投票导演」
     （一次安排 2~5 人按人设选边、随口一句落评论，已投名单喂进去防重投，
     投票不匿名）；requestReplies 分流投票帖；genMore 成功后 sweepVotes
     扫尾（90s 独立冷却，失败静默不挡主流程）；
   · page-qunsheng.js：类型「投票」+「+ 投票」真接入；投票选项编辑器
     （输入不 rebuild 保焦点）；详情页投票块（微博式：自己投过才揭晓占比条
     +票数+投票人；改投/撤票）；信息流卡片报「N 人已投」；
   · forum-share.js：describeForModel 补投票段（选项+票况）；
   · scripts/smoke.js：+3 回归（投票数据层 / 投票导演 / 转发喂模型票况）。
   → 必须跳版本：forum-core.js / forum-gen.js / page-qunsheng.js /
     forum-share.js / scripts/smoke.js 都变了。 */

/* v240（2026-10-16）：**群声发帖状态修复 + 朋友圈转发喂模型批**——
   · page-qunsheng.js：renderCompose 的 state 挪成模块级 composeState ——
     此前点「长文/求助」刚 setState 就被 rebuild 整页重跑冲回 normal
     （用户实测「点不动」），图片附件同款会被清；ghostwrite 改直读
     composeGW.on（落 state 会被首建快照钉死）；page() 加 onOpen 钩子，
     compose 注册时重置草稿（freshOnOpen 每次 open 都走，rebuild 不走）；
   · forum-share.js：+describeForModel —— 朋友圈 qsRef 喂模型时现读原帖
     正文（300 字截断）与最新 5 条留声（各 50 字），匿名纪律不变（全走
     公开投影，绝不露账号 id）；死帖/被封/非公开返回 null fail-closed；
   · moments-ai.js：评论动态/回复评论两条回应链接 qsRefBlock —— char/NPC
     看得到转发的帖子内容才接得上话（user 2026-10-16 拍板）；
   · life-feed.js：群声转发的信息流行给标题+作者+板块（不放全文，防挤窗口）；
   · scripts/smoke.js：+describeForModel 回归（正文/留声进模型侧、
     零账号 id、死帖 fail-closed）。
   → 必须跳版本：page-qunsheng.js / forum-share.js / moments-ai.js /
     life-feed.js / scripts/smoke.js 都变了。 */

/* v239（2026-10-15）：**聊天历史时间标注批**（方案 A，用户拍板）——
   真机复现：昨晚发的消息今天触发回复，char 以为是今天发的 ——
   喂模型的历史此前只有 role+content，「现在」层（timeFacts/群逐本体时间块）
   很全，缺的是历史每条的「何时」。数据层早有时刻（私聊 msg.timestamp /
   群 msg.createdAt），纯装配层渲染：
   · calendar.js：histStamp（行内戳唯一出口：同天钟点/昨天/月日/跨年四档，
     私聊按 char 时区、群聊按设备本地；at 缺失不编时间）+ gapLine
     （间隔事实：<5 分钟不说话，相对时间由代码算好直接喂，不让模型自己算差值）；
   · prompt-engine.js：assembleOnline history 出站带行内戳 + time 槽追加间隔
     （worldbook/taimpact 的相关性判据仍吃原始 history，戳不进关键词匹配；
     photo 数组只戳 text 分量；无 at 原样出站，黄金基线不受影响）；
   · page-chat.js：旧路径（引擎关）对称实现（透传 at + 收尾戳 + 间隔行）；
   · page-presets.js：预演镜像同口径透传 at；
   · page-group-ai.js：[RECENT_GROUP] 行内戳 + 间隔行（lastAtG 排除
     「群聊已创建」等系统事件条 —— 事件条不是发言，不该顶掉真实的最后消息）；
   · scripts/smoke.js：+5 回归（histStamp 四档 / gapLine 分档 / 引擎路径
     戳+间隔 / 多模态分量级戳 / 群戳+间隔），SW 基准 v238 → v239。
   → 必须跳版本：calendar.js / prompt-engine.js / page-chat.js /
     page-presets.js / page-group-ai.js / scripts/smoke.js 都变了。 */

/* v238（2026-10-14）：**人设链路统一出口批**（勘察-人设链路全量-2026-10-13）——
   · prompt-engine.js：compileCharacter 分层重写（sub=补充层 root 在前、
     红线并集、短字段逐项）+ c05 有效正文按 trim 判 + 空/双空诊断字段；
   · page-chat.js：chatDiag 装配诊断状态机（新旧两分支接线 + reroll 同覆盖）
     + 引擎关旧路径人设/协议修复 + 查岗画面导演改走 compileCharacter；
   · 8 处绕过统一出口的链路全部改调 PE.compileCharacter（分层+红线并集）：
     群聊 page-group-ai / 查手机 page-phone-ai（结算+被抓现行，删 800 截断）/
     朋友圈 moments-ai（删 600 截断）/ 日历日程 schedule-gen（删 1200 截断）/
     以身入局 book-core / ta ta-model / 日记 page-diary / 离线总结 page-offline /
     线上整理 page-summary；
   · forum-gen.js：defaultTransport 补 maxTokens:3000 —— 群声多帖 JSON 超
     默认 1024 常被截断 → 解析失败（真 API 验证复现，gemini/glm 双验）；
   · scripts/smoke.js：人设链路装配回归 + forumGen 参数覆盖回归（+500 行级）。
   → 必须跳版本：上述全部运行时文件都变了。 */

/* v237（2026-10-12）：**数据链路 P1+P2 修复批**（核查报告第二批）——
   · page-chat.js：旧组装路径（引擎关）补 L4 向量召回注入 —— 此前
     引擎一关「相关的过去」整层消失，prefetch 白跑；同步读 memoryVec.text，
     没配/没召回不加空段（P1-1）；
   · page-repo.js：点赞型领取条件改读本地 repoLikedIds —— 服务端无账号
     体系恒 met:false，「点赞才能领」的件此前永远领不到（P1-2）；
   · photos.js + page-chat.js：删图先查全局引用（photos.mediaReferenced，
     扫全部聊天 + 相册记录），聊天还在引的 blob 不再被误删（P1-3）；
   · store.js / core.js / forum-core.js：摘死键 forumShareReceipts /
     forumDrafts（全库零读写，回执实落 forumShares.openedAt）；
   · ta-proposal.js：摘无写入方的 'failed' 状态与无调用方的 hasRequestFp 导出；
   · core.js：删房名单差集补齐 —— 三张盖章数组表（dropEvents/momentPending/
     momentWall）进 scoped 名单；挂 char/chat/group id 的动态单键
     （charMem:/charState:/openLoops:/attentionInbox:/relationIntent:/
     proactiveState:/phoneRawFail:/sumCursor*:/sumRawFail*:/groupInner:/
     groupPending:）趁宿主还在逐个 remove；memoryIsland/charSettings/
     charVoice 三张 byChar 映射按 doomed 过滤。repo* 设备级键刻意不清；
   · scripts/smoke.js：forum 键数 13→11、新增删房差集行为级断言。
   → 必须跳版本：core.js / store.js / forum-core.js / ta-proposal.js /
     page-chat.js / page-repo.js / photos.js / scripts/smoke.js 都变了。 */

/* v236（2026-10-12）：**数据链路 P0 修复批**（施工单 v1 第一批）——
   · repo-worker.js：第 125 行 `m` 补 `let`（严格模式 ReferenceError，
     其后 9 路由全灭）；publish INSERT 列/槽/绑定三方对齐（19 列 =
     17 绑定 + 字面量 0/1）—— 发布/席间/点赞/条件/inbox/下架全链路通；
   · repo-core.js：postComment 的未定义 `cfg()` 改读 repoCfg（铺子昵称
     生效）；page-repo.js 两处发送点包 try/catch，同步异常也恢复按钮；
   · prompt-engine.js：assembleOnline 补 lamptag/slowmail 两个 case
     （槽注册了但没接线，引擎开时模型收不到 [灯:]/[慢递:] 说明书）。
   → 必须跳版本：repo-core.js / page-repo.js / prompt-engine.js / scripts/smoke.js
     都变了（worker 不经 SW，同批带跳）。 */

/* v235（2026-10-12）：**挂件灯三点返修批**（用户反馈）——
   · 留言带「||」分割符：长按「留在灯上」原来送整条 '||' 拼起来的原文，
     改成送**长按的那个气泡**（bubbleText(msg, idx)，page-chat）；
     lampNotes.add 里再把 || 兜底转成换行（一句话一行，卡面按 \n 分行）；
   · 同句四层重复：核心按 defs[n % defs.length] 往 36 个挂点轮挂，
     1 条留言 + 5 空板会被挂 6 遍。lampCards() 补齐到 36 张 ——
     每条留言只占一个挂点，空板循环补数；超 36 条取最新 36 条；
   · 一行字数太少：paintCard 文字卡折行改**自适应字号**（从 40 往小试，
     每个候选字号重新折行，块高放得下就用）—— 折行与落笔同一个字号，
     行宽撑满；vendor/lamp 的 html 源一并补上 2026-10-10 漏同步的折行修复，
     重建后两份 core 与 html 三方一致；
   · page-desktop 导出 lampCards 供冒烟核「一条留言只挂一个挂点」。
   → 必须跳版本：page-chat.js / page-desktop.js / vendor/acrylic-lamp-core.js /
     vendor/lamp/acrylic-lamp-core.js / vendor/lamp/acrylic-lamp.html /
     scripts/smoke.js 都变了。 */

/* v234（2026-10-11 晚 8：55 返修批三）——
   · **白字根因**：style.css 把帷境夜色板（--wj-text:#eef2f8）直接挂在
     .yr-root 上、盖掉纸皮页级暖板 → yr 三页整树浅字。夜色板组收窄回
     .page[wj-] + .wj-sheet 专属，yr 三页全靠 home-style 纸皮暖板；
   · yr-board：右下角「边缘框」= .yb-back 基础 width:100% 进 .yb-nav flex
     行不缩 → 把 .yb-open 挤出屏右缘。nav/cover-acts 里的 yb-back 补
     width:auto；「开局」改**直接进 yr-play**（不再弹回第一步）；
     委托/暗线/限制等重点改酒红标签（.yb-key）；
   · 御膳房：报头 30px→22px 收小 + 左侧加「‹」小返回钮（crumb 页同样带），
     删每页「← 退出御膳房」条；DEMO_ITEMS 示例件整块删除，公共铺面空时
     显示空态文案。
   → 必须跳版本：style.css / page-yr-board.js / page-repo.js 都变了。 */

/* v233（2026-10-11 晚 8：10 返修批二）——
   · 御膳房全 App 退出按钮（每页报头上方「← 退出御膳房」）；
   · 以身入局：**撤门面/手机壳**——点开直接档案架全屏；纸皮下白字全改墨
     （yr-take/yr-motto/yr-card/报头）；滚动条藏掉；无岛占位页也套纸皮；
   · yr-board：选定身份/局牌后**自动进下一步**；
   · yr-play：局内手机面板改**小手机造型**（280 宽圆角壳+听筒条）；
   · 铺面：删「部署 Worker 后换真件」提示句；示例件标注 TODO 部署后删。
   → 必须跳版本：page-yishenruju.js / page-yr-board.js / page-yr-play.js / page-repo.js。 */

/* v232（2026-10-11 晚 7：50 返修批）——
   · 以身入局：主页改「门面」（全宽 hero + 📱手机按钮），点手机才进小手机壳
     （.phone-mode 才套壳），手机内可「收起」回门面；
   · 开炉：sheet 改**完整页面 repo-publish**，同学录式表单（rp-field 标签+下划线）、
     封面 URL（替代头像 URL，cover 列上 worker）、发布预览卡（实时）、领取条件三选
     可取消（「不设」并入取消语义）、门牌码可选+白话说明；
   · 板块：直进公开铺面对应货架（不再弹门牌 toast）；
   · 铺面：rp-shelf 层板视觉 + DEMO_ITEMS 示例件（无服务端/空态垫底，带示例标）；
   · 字号整体调大（14.5 基准）。
   → 必须跳版本：page-yishenruju.js / page-repo.js / repo-core.js / worker / index.html。 */

/* v231（2026-10-11 晚 7 半）：**席间开张 + 群声关注补全**——
   · worker：comments/condition_met 表 + items.likes 列（自动迁移）；
     /item/:id/like、/comments(GET/POST)、/condition?device=、/inbox(X-Repo-Token)；
   · repo-core：deviceId/likeItem/listComments/postComment/checkCondition/myInbox；
   · 详情页：♡点赞 + 席间（说一句/尝后感列表）+ 领取条件真校验（服务端没连上先放行）；
   · repo-inbox 真数据：我名下件收到的席间消息 + 未读数 + 「都看过了」；
   · 群声关注补全：forum-core isFollowing/toggleFollow/followsOf（forumFollows 数组键，
     按岛隔离）+ getHomeFeed follow 流真数据（本地过滤）+ postCard/作者主页关注按钮；
   → 必须跳版本：worker/repo-worker.js / repo-core.js / page-repo.js / forum-core.js /
     page-qunsheng.js / scripts/smoke.js 都变了。 */

/* v230（2026-10-11 晚 7）：**Worker v2 + 作品详情页**——
   · worker/repo-worker.js：/public-shelf（免门牌公共铺面，type/q/sort）、/item/:id/meta
     （包外元数据不含包体）、publish 存新列（summary/access/condition/visible/updated_at）、
     visible=1 的件免门牌下载；老库首请求自动 ALTER 补列（幂等）；
   · repo-core：publicShelf/itemMeta；pack* 带 visible；
   · 首页重构：公共铺面卡流（最新/热门 chips + 板块/搜索过滤）+ 暗铺门牌货架（下移保留）；
     点击公共件 → repo-item 详情页（大头卡/作者的话/领取条件/权限说明/打包带走，backbar 无底栏）；
   · 开炉向导：勾「同步到公共铺面」→ manifest.visible；
   → 必须跳版本：worker/repo-worker.js / repo-core.js / page-repo.js / index.html 都变了。 */

/* v229（2026-10-11 下午 4）：**仓库改名「御膳房」+ 底栏/我的 改版**——
   · 五位底栏：首页 / 板块 / ＋开炉（中央凸起墨钮，点击弹发布向导） / 消息（占位） / 我的；
     原「我的发布」并入「我的」，门牌收进「我的 → 暗铺门牌」；
   · 「我的」装修：资料加简介、头衔可**佩戴**（worn 态墨底反白，席间/作者主页将展示）、
     我的件管理（上架/下架/重新导入）；
   · 板块 = 六类型分区（皮相/世界书/咒文/整岛/局中世界/妆造），P0 数据仍走门牌货架；
   · 桌面 p3-repo label 仓库→御膳房（LAYOUT 25）；
   · 权限口径定案：明厨（全公开）/ 暗铺（需授权码），条目级上锁 —— 发布向导 P1 改。
   → 必须跳版本：page-repo.js / page-desktop.js / index.html / scripts/smoke.js 都变了。 */

/* v228（2026-10-11 下午）：**以身入局塌页修复（线上真机抓到）**——
   ensureHomeStyle 的部件规则直接写 YR_PAGES + ' .yr-top'：选择器列表里
   后代空格只粘最后一个 → `.page[yishenruju]` 等**页面本体**直接命中
   报头规则（position:relative / bottom:-5px / height:1px），inset:0 被干掉，
   整页塌成顶部一条 10px 小白框、看得到桌面变暗（用户：白框边 + 屏幕暗一点）。
   改 yrSel()：对三个页面选择器逐个接后代后缀。
   → 必须跳版本：page-yishenruju.js / index.html（?v=228）都变了。 */

/* v227（2026-10-11）：**CACHE 补跳**——工作区在 v223 之后连改了四批运行时脚本
   （仓库批 index.html ?v=224、以身入局 v225/v226 换装与 TXT 导入等，
   index.html 已把 page-yishenruju.js / page-desktop.js / page-repo.js
   的 ?v= 顶上去），但 CACHE 没跟着 +1——违反「改运行时脚本必须 CACHE +1」。
   后果：装着旧 SW 的设备上，fetch 处理器 caches.match(req,{ignoreSearch:true})
   会把带新 ?v= 的请求**无视查询串**命中旧缓存条目，先回旧文件再后台更新
   （stale-while-revalidate），首次加载就是新旧脚本混装 —— 表现为「无痕好、
   普通窗口怪」「刷新几次行为不一致」这类幽灵症状。v223→v227 一跳到当前。
   → 必须跳版本：index.html / page-yishenruju.js / page-desktop.js /
     page-yr-board.js / page-yr-play.js / book-core.js / store.js / app.js 都变了。 */

/* v223（2026-10-10 晚 6）：**仓库上线批**——
   · Worker 已部署：D1 + KV（R2 需 Dashboard 手动开通 → 换 KV 存包体，
     repo-worker 下载口做 R2/KV 双兼容），线上地址烤进 repo-core
     DEFAULT_BASE，页面上的地址填写框删除；
   · 首个门牌「meiguan / 安乐的试吃铺」已建（线上 /shelf 验证通过）；
   · 仓库 App 底部四 tab（货架/我的/门牌/我）+「我」板块：昵称/头像 URL
     资料（发布自动预填）+ 头衔墙（本地推导开炉掌柜/尝过一口，
     甜度系虚线占位待 P1）；外观空壳位 (3,5) 换仓库真入口（LAYOUT 24）。
   → 必须跳版本：repo-core.js / page-repo.js / page-desktop.js 都变了。 */

/* v222（2026-10-10 晚 5）：**设定仓库 P0（方案-设定仓库-v1）**——
   · 新增 worker/（repo-worker.js + wrangler.toml + schema.sql）：D1 索引/
     门牌 + R2 包体，端点 publish/shelf/item/gate/search/下架；单件 5MB；
     作者令牌首发布时签发。**部署要 wrangler deploy + d1 create**（不走
     GitHub HTTPS），仓库地址在仓库 App「我的」里填；
   · 新增 repo-core.js（Sleepy.repo，设备级键 repo*）：打包（角色卡/整岛包，
     媒体一律 URL 制，聊天/朋友圈/日记/照片/马甲/API 不进包）、发布/货架/
     下载、门牌校验与链接解析（?g= 短码）、导入（角色卡进当前岛；整岛包
     生成新岛——角色/以身入局档案全带，世界书/美化向导可选「用我的/带包里的」）；
   · 新增 page-repo.js 仓库 App（货架/我的/门牌三板块 + 发布向导 + 导入
     向导 + 深链 ?g= 识别 + 粘贴识别 + 链接复制）；index.html 加载 +2；
   · page-desktop：第 4 屏 p3-repo 仓库真入口（ICONS.repo 收纳箱），
     LAYOUT_VERSION 23→24；smoke 户型基准同步。
   → 必须跳版本：repo-core.js / page-repo.js / page-desktop.js /
     index.html 都变了。 */

/* v221（2026-10-10 晚 4）：**导入世界入世游玩接线（方案 v1.2 施工）**——
   · book-core：startRun 支持 txt 盒（run.world='txt:<boxId>'，chapterIdx 按起始章
     对齐，带 divergences 改动账本 + npcStates）；worldFor 组装当轮世界对象
     （原事实 + 改动账本 + NPC 当前态 + 当前章原文）；applyTxtVerdict（改变/
     反应/推进 三行判定落账本，进度程序按章算）；patchBox（白名单字段）；
     sealBox（手动封禁出口）；
   · buildBookMessages txt 分支：四件套注入（席位 / 剧情地图 / 改动账本 /
     当前章原文节选 2600 字 / 前情）+ 世界角色铁律（无人知道原剧情与委托）+
     委托者站局外口径；判定块新增 改变/反应/推进 三行；
   · yr-import 预读协议升级：brief/npcs[{name,role,fact}]/places/
     nodes[{at,event,mutable}]/suggest{requester,publicGoal,hiddenGoal,
     restriction,why}——剧情地图 + NPC 档案 + 委托建议卡一次生成；
   · yr-board 第 3 步：导入世界显示委托卡 + 建议卡（采用/换人重提，
     reSuggest 不重读全书只重出建议）；txt 盒开局放行；
   · yr-play：世界与委托全部走 txt 适配（deck 目标/手机面板/结算叙述四样
     口径：委托者真愿望满意度/世界受益/char 满意度/完成度）；设置面板加
     「封存这个世界」（两次点按确认，sealBox 盖「已封存」进第二层书架）。
   → 必须跳版本：book-core.js / page-yr-board.js / page-yr-play.js 都变了。 */

/* v220（2026-10-10 晚 3）：**档案盒顶签 <br> 修复**——h() 第三参是
   textContent，'以身入局<br>世界档案' 里的 <br> 原样显示成文字；
   yr-box-top 改走 innerHTML（空位签同修）。真机走查（大厅/建档三步/
   游玩/导入四页全流程）通过。
   → 必须跳版本：page-yishenruju.js 变了。 */

/* v219（2026-10-10 晚 2）：**群声 char 头像 + 以身入局第二轮回炉**——
   · 群声：char 非匿名身份贴自己的「微信头像」（core.setAvatarBg 同源，
     qs-avatar/qs-mini 加 has-img 盖字母脸；匿名仍匿名脸）。作者主页/通知同接；
   · yr-board：领局牌三步拆成独立页（进度点 + 上一步/下一步，照建群走法）；
     场景图支持多张（book-core 新增 setScenes：box.sceneRefs，coverRef 同步第一张）；
   · 全部换纸面撞色：ensureHomeStyle 推广到 yishenruju / yr-board / yr-play
     三页（Sleepy.yrHomeStyle），帷境深纱部件换白瓷面；
   · TXT 导入（需求清单 §十 第一版）：新页面 yr-import（page-yr-board.js 内）
     —— 选 txt / UTF-8↔GB18030 切换+乱码提示 / 章节切分（第X章正则，兜底按长度）/
     章节名可改 / 选起始章 / 手填委托与扮演角色 / 一次轻量 AI 预读（简介+人物+地点，
     失败不阻塞）→ createBoxFromImport 上架；原文落 bookImports（store/core 登记）；
     入世游玩接导入世界 = 下一批（开局按钮如实提示，不冒充可用）；
   · yr-play：顶部场景条（多张手动 ‹ › 切换；剧情自动换景等世界包批次）。
   → 必须跳版本：page-qunsheng.js / page-yr-board.js / page-yr-play.js /
     page-yishenruju.js / book-core.js / store.js / core.js 都变了。 */

/* v218（2026-10-10 晚）：**群声归属修复 + 论坛身份编辑 + 以身入局首页回炉**——
   · 群声归属 bug：生成链匿名树洞以前「借 user 主号发」（resolveSeedAuthor '@anon'），
     「我的帖子/回复」按 authorAccountId 过滤 → 别人的匿名内容全挂到 user 头上。
     改借匿名池号（forum-core ensureSeed ⑤，ownerType='anon'，永不出现在身份列表）；
     一次性迁移把历史借主号的匿名帖/匿名回复划给池号（map 标记 forumAnonPoolMigrated）；
   · 论坛身份编辑：「我的」页每个身份加「改名/头像」——名字（12 字内）+
     头像字 + 8 色底；forum-core 新增 updateAccountProfile（只认 user 自己的）；
     publicAuthorOf 头像字支持 avatarGlyph；
   · 以身入局首页回炉（用户：不要悬浮球、不要底部说明）：悬浮球与相关
     CSS 整体拆除；封存层从一句空话改成真书架（没货摆三只虚线空位）。
   → 必须跳版本：forum-core.js / forum-gen.js / page-qunsheng.js /
     page-yishenruju.js / store.js / core.js（删岛映射键名单）都变了。 */

/* v217（2026-10-10）：**用户四点反馈批**——
   · 群声：默认玻璃壳头（def.title 的「群声」）整条藏掉 —— 各页自带
     报刊报头/crumb，板块名就在那，壳头重复还占高（page-qunsheng.js）；
   · 查手机：桌面右上角刷新（一次整体结算 phoneLife 原卡，跨 App 出内容）
     + 每个 App 页头独立刷新（page-phone-ai.js 新增 refreshApp / APP_FOCUS_ASK：
     同协议卡 + [FOCUS] 该 App 专属指令 + [EXIST] 已有条目防重复，
     官方五 App 各一份新提示词；page-phone.js 按钮接线，style.css .ph-refresh）；
   · 挂件灯：留言字太小 —— vendor/acrylic-lamp-core.js paintCard 只按 \n
     分行，40 字留言被压一行硬缩到几像素；新增 wrapLines 按宽逐字折行 +
     按行数回推字号（vendor/lamp 副本同步）；
   · 以身入局：档案架大厅换装 —— 群声同族纸面 #f4f0e7 + 墨色撞色
     （眉标/层标黑底反白小条、报头双细杠），yr-board/yr-play 仍帷境夜色；
     三个身份从环形牌台改成悬浮球（一颗「局」球点开三颗身份球
     观/随/行，球下挂名；没有可进世界时整簇不出现）。
   → 必须跳版本：page-qunsheng.js / page-phone.js / page-phone-ai.js /
     style.css / page-yishenruju.js / vendor/acrylic-lamp-core.js 都变了。 */

/* v216（2026-10-09）：**群声 v216 返修批（用户六条点名）**——
   · 帖子详情页：主楼/动作条/回复列表以前直接平铺在没有 overflow 的 .qs-root 里，
     被 .page 的 overflow:hidden 裁掉 → 整屏推不动；全部收进 .qs-main 滚动层
     （首页/消息页一直有，就这一屏漏了），回复框留在层外钉住；
   · 返回键：一屏只留一枚 —— 消息页去掉重复的「返回桌面」，全族文案统一「‹ 返回」；
     **错误态（帖子/板块/作者不在了、进不去社区）补上返回键** —— 壳头在这一族是
     display:none，错误态没返回就是一屏死路；
   · char 匿名：char 可以选择匿不匿名 —— 数据层新增**单楼匿名** comment.anonymous
     与 publicAuthorOfComment（同帖同人同别名、换帖换脸；整帖匿名优先），
     char 自发帖由模型按性格自选 anonymous，另有 setAnonPref/getAnonPref 偏好出口；
   · 生成纪律：去掉「至少 2 帖由角色发」的硬指标（社区不是粉丝群），
     全量加【禁止复读人设】与【居民占多数】（催更回复 3~6 条，上限由 4 提到 6）；
   · 同人创作真的会写正文：compose 新增「请人代笔写一篇」（一次一整篇、分自然段），
     详情页按章节分节渲染 + 「追更下一节」（最近读者留言进 prompt，作者自选采纳，
     采纳了才在章节末尾标「听进去的建议」）；数据层新增 updatePost（白名单）。
   → 必须跳版本：page-qunsheng.js / forum-core.js / forum-gen.js 都变了。 */


/* v215（2026-10-09）：**以身入局 3B 收尾批（悬浮球三件套 / 局印干预 / 自动档 / 结算封档）**——
   · book-core：addInventoryItem（实物/存档两态）/ addIntervention + pending/consume
     （干预不单独调用，并入下一轮注入，不计异常度）/ settleScores（状态机算分，不信模型现编）
     / finishRun（run.ended + settlement，档案盒 closed + 已结案戳）/ getLastRunByBox；
   · buildBookMessages：有未消费传话时追加【局印传话】块（本轮必须体现）；
   · page-yr-play：悬浮球按身份换装（boss-watch=印/窗/TA背包只读，B套；
     boss-join=机/囊/印，staff 局印置灰，A套）；局印面板盖传话+撕回；背包面板
     收实物/存档+结案折算预览；观测窗（异常度/进度/轮数/最近判定）；自动档
     「让 TA 自己走一段」（默认 3 轮设置可改，可停；异常度≥60/进度满/失败刹车；
     离开页面即停=前端循环不是后台任务）；结算封档面板（结算叙述一次可选调用
     + 直接封档两出口）；日志条带局印批注（sealNote）；结案后复显结算卡。
   → 必须跳版本：book-core.js / page-yr-play.js 都变了。 */

/* v214（2026-10-09）：**以身入局整体验收批（真机 390×844 走查修复）**——
   · 三页（yishenruju / yr-board / yr-play）补 onShow→ctx.rebuild：
     页面实例缓存复用，先开页后进岛会拿到旧空态 DOM（实测复现）；
   · page-yishenruju：rebuild 必须指向具名 wrapper（renderEntry）——
     写 render(ctx) 会解析到内层 render(ctx,sid)，sid undefined →
     ensureBoxes 抛「必须带 sandboxId」，body 被清空白屏（实测抓栈）；
   · page-yr-play：round 一进来重读 store 最新 run —— 修「幽灵 pending」：
     闭包深拷贝快照被 push 后永远摘不掉，每轮点击整表写回陈旧数组，
     store 每轮净 +1 条 pending（stub 抓栈定位：persistRun←round/fail 双写）；
     busy 提为模块级（rebuild 重画后旧闭包的局部 busy 会丢，双发防线）；
   · style.css：yr-board / yr-play 加入帷境夜色换皮组 —— 之前只有大厅有，
     建档/游玩两页白底 chrome 配深色卡片（真机截图确认）。
   → 必须跳版本：style.css / page-yishenruju.js / page-yr-board.js / page-yr-play.js 变了。

   v213（2026-10-09）：**以身入局第三刀 A（入世游玩核心循环）**——
   · 新增 page-yr-play.js：行动日志时间线 + 常驻委托卡（明面目标/异常度/进度）
     + 两种轮（在场轮 user 说话 / 行动轮「看 TA 走一步」）+ 右上角设置抽屉
     （每轮字数三档 + 模型连接去重单选，app 指定优先于 feature 分配）；
   · book-core：DRILL_WORLD/DRILL_BRIEF 单一出处 + buildBookMessages
     （协议四块注入+判定格式）+ parseVerdict（剥 <判定>，负增量驳回）
     + applyVerdict（异常度累计/进度只进不退/日志成条）；
   · api.js FEATURES + 'book'（以身入局·入世轮/行动轮）；
   · 导航闭环：开局→「进入世界」；进行中的档案盒直进游玩页；
   · smoke 新增管线功能断言（注入四块/剥离/写回纪律）。
   → 必须跳版本：index.html / book-core.js / page-yishenruju.js /
     page-yr-board.js / page-yr-play.js / api.js 都变了。 */

/* v212（2026-10-09）：**场景图接入建档**——
   · 用户指正：选图通道是有的（photos.pick 走 file input → media 压缩落盘，
     朋友圈/相册同款），之前 grep 漏了动态赋值的 .type='file'；
   · book-core.setCover（box.coverRef 落库，可换/可撕 null）；
   · 建档第 3 步加「本书场景图」卡：+ 从相册选一张 / 换一张 / 撕掉，
     media.url 回显缩略图；游玩页头图与档案封面后续批次共用它。
   → 必须跳版本：book-core.js / page-yr-board.js 都变了。 */

/* v211（2026-10-09）：**以身入局第二刀（领局牌与建档）**——
   · 新增 page-yr-board.js（领局牌建档页）：①局内身份（盒子定过即锁死显示）
     ②领局牌环形选 c 层占位（演练三枚：借宿的旅人/新来的帮工/外来的调查员）
     ③建档确认（演练世界委托卡：守灯人陈婆/明面/暗线/限制/报酬）→ 开局；
   · book-core：startRun（运行落库 bookRuns + 档案盒刻 box.identity 锁死 +
     重复开局幂等续接）/ getRunByBox；身份口径改「每个世界定一次锁死，
     大厅默认只影响未定的新世界」；
   · 环形牌台泛化成 Sleepy.yrRing 供大厅与建档页共用；index.html +1；
   · smoke 新增功能断言：startRun 真跑（落库/锁死/幂等）。
   → 必须跳版本：index.html / book-core.js / page-yishenruju.js /
     page-yr-board.js 都变了。 */

/* v210（2026-10-09）：**档案架改竖书脊 + 回牌台入口加大**——
   · 档案盒照档案架 Demo v3 移植成档案馆书架式：62×218 竖盒、竖排书脊字
     （writing-mode vertical-rl）、纸签顶、圆扣手、架板、纸/夜/酒三色轮换、
     待上架/演练斜跨封条、空位虚线盒（原横卡是用户点的「不是竖着的档案咧」）；
   · 「点不回去看牌台」：虚线小按钮太不起眼 → 身份卡整卡可点回牌台 +
     按钮改「↺ 回牌台换身份」+ 卡上加提示文案（链路本身是通的，纯入口问题）。
   → 必须跳版本：page-yishenruju.js 变了。 */

/* v209（2026-10-09）：**以身入局大厅返修（用户真机反馈）**——
   · 颜色没铺满露白底：页面 chrome（顶栏/底色）只认 .page[data-page^="wj-"] 换皮组，
     yishenruju 页加进同一组（色板组 + chrome 变量组两处），像素级复核全页夜色；
   · 身份选择升级为环形牌台（照领局牌 Demo v2 coverflow 口径移植）：
     拖拽/箭头/圆点换牌 + 明细行 + 「定下这一枚」；拖后误触 click 已滤；
   · 档案盒轨道加 scroll-snap。
   → 必须跳版本：style.css / page-yishenruju.js 都变了。 */

/* v208（2026-10-09）：**以身入局 P0 第一刀（档案架大厅）**——
   · 新增 book-core.js（数据层：档案盒/任务运行/映射键，镜像 forum-core
     scoping 口径；红线=app 记忆不进角色记忆通道）；
   · page-yishenruju.js 从诚实占位页升级为档案架大厅（帷境色 --wj-*）：
     下一局身份三选（老板纯看/老板亲自参与/员工，进局锁死）+
     第一层「已建档世界」（待上架占位盒 + 局内演练盒，均明示下一批开放）
     + 第二层「封存」空架；index.html 加载列表 +1；
   · store.js 新键 bookBoxes/bookRuns/bookSettingsBySandbox；
     core.js 删房名单 + 映射键清理同步登记。
   → 必须跳版本：index.html / book-core.js / page-yishenruju.js /
     store.js / core.js 都变了。 */

/* v207（2026-10-09）：**群声催更卡死修**——
   · 症状：催更按钮「按不动/按了没反应」。两个根因：
     1) api.js runChat 非流式分支 loopP 只 .then 无 .catch —— requestOnce
        executor 同步异常会 reject，链路静默断，onDone/onFail 都不触发，
        调用方永久 disabled。补 reject 分支转 onFail；
     2) page-qunsheng 催更按钮零反馈：disabled 无样式、无提示文案，
        模型生成 10~60s 期间看着跟没按一样。补「催更中…」状态文字 +
        即时 toast + disabled/:active 样式 + 点击处理器同步异常 try/catch
        兜底（保证 settle 必执行，按钮必恢复）。
   → 必须跳版本：api.js / page-qunsheng.js 都变了。 */

/* v206（2026-10-08）：**以身入局注册批**——
   · 新增 page-yishenruju.js（「以身入局」App，首版诚实占位页：
     Sleepy.register + 「还没布置好」提示，不冒充完成）；index.html 加载列表 +1；
   · page-desktop：第三屏组件商城空壳格 p3-store 换 p3-yishenruju 真入口
     （type app / 专属线稿图标 / label 以身入局），LAYOUT_VERSION 22→23；
   · app.js PLACEHOLDER 表加 yishenruju 兜底条目；
   · scripts/smoke.js 第 3 屏断言改锁新格 + EXPECTED_SW_CACHE 同批回写。
   → 必须跳版本：index.html / page-yishenruju.js / page-desktop.js / app.js 都变了。 */

/* v205（2026-10-08）：**集中核查修复批一**——
   · 收藏并馆：page-collection 并三路（weEntries+favorites+票根），
     老 favorites 页退役（page-chat.js）、page-we 计数同口径、收藏 toast 改口径；
   · 生图：page-imggen 试一张改走正式管线（实验 UI 退役）、newApi 不再预灌预设词；
   · app.js toast 支持 opts.onClick（总结完成可点直达留痕）；page-summary 文案与跳转；
   · 群声：page-qunsheng 板块主页（qunsheng-board）+ 布局返修（页内滚动/边距/字号）；
   · 断链修复：page-wj-curtain 分享卡可点直达 wj-read；
   · 新增 schedule-gen.js（每日角色日程生成器）+ calendar.js AUTH_VIA +schedule_switch；
     page-chat 两个触发点。index.html 加载列表 +1；
   · calendar.js：日程注入补「不是硬性剧本」一句（用户：不要太死）；
     schedule-gen.js 提示词允许把「user 的影响」排进日程；
   · page-we.js：记一笔抽屉加「✦ 帮我们记」（B1，模型起草、user 确认落库）；
   · ⑦ 副 API 功能分配：api.js（candidates 按 ov.feature 收窄 + requestForFeature
     + FEATURES 清单）、store.js subApiFeatures 键、page-subapi 功能分配组、
     九个功能点接线（forum/moments×3/heartbeat/diary/offline/proactive/
     talife/schedule/director）。勾选功能严格走副 API 轮询，全败报错不回落。
   → 必须跳版本：以上文件全变了。 */
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
    return warmUrls(c, urls).then(function () { return warmInlineAssets(c, urls); });
  })['catch'](function () { /* 联网失败就算了，交给运行时缓存 */ });
}

/* 装一批 url 进缓存：命中就不动，单个失败不拦整体。 */
function warmUrls(c, urls) {
  return Promise.all(urls.map(function (u) {
    return c.match(u).then(function (hit) {
      if (hit) return null;
      return fetch(u).then(function (rr) {
        if (rr && rr.ok) return c.put(u, rr.clone());
      })['catch'](function () { /* 单个失败不拦 */ });
    });
  }));
}

/* 二级预热（v256）：**js / css 里引的本地图片**——
   index.html 的 src/href 扫不到它们，而 JS 常量里写死的默认头像正是这种
   （core.js: DEFAULT_AVA_CHAR = 'art/avatar-ghost-char.png'）：不预热的话，
   SW 一装完就断网打开，头像位是空的 —— 运行时缓存要等它真被请求过一次。
   做法是：只对已入缓存的 js / css 读回文本抽路径，逐个装进来。

   两个收口，别改松：
   · 目录白名单 AssetDirs —— 只扫项目自己的资源目录。放开通配会扫到
     vendor/three 之类的库，那里面的相对路径在这儿多半不存在，白送一串 404。
   · 必须是被引号包起来的相对路径 —— core.js 注释里也写了同名的文件名，
     不成串的那些不算引用。
   新加资源目录时把名字写进 AssetDirs 就行。 */
var AssetDirs = '(?:art|icons|preview)/';
function warmInlineAssets(c, urls) {
  var readings = urls.filter(function (u) {
    return /\.(?:js|css)$/.test(u);
  }).map(function (u) {
    return c.match(u).then(function (hit) {
      return hit ? hit.text() : '';
    })['catch'](function () { return ''; });
  });
  return Promise.all(readings).then(function (texts) {
    var extra = [];
    texts.forEach(function (t) {
      if (!t) return;
      var re = new RegExp('["\'](\\.?\\/?' + AssetDirs + '[^"\')\\s]+\\.(?:png|jpe?g|webp|gif|avif|svg))', 'gi');
      var m;
      while ((m = re.exec(t))) {
        var u = m[1];
        if (/^(https?:)?\/\//i.test(u)) continue;      /* 外站不管 */
        u = u.charAt(0) === '.' ? u : './' + u;
        if (extra.indexOf(u) < 0 && urls.indexOf(u) < 0) extra.push(u);
      }
    });
    return extra.length ? warmUrls(c, extra) : null;
  });
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
    'justify-content:center;background:#F7FAFE;color:#2F3A47;' +
    'font:15px/1.7 system-ui,sans-serif;text-align:center">' +
    '<div style="padding:32px">' +
    '<p style="font-size:17px;margin:0 0 10px">连不上，本地也还没有缓存</p>' +
    '<p style="margin:0;color:#8A7A67">第一次打开需要联网。' +
    '加载过一次之后，再到桌面打开就能离线用了。</p>' +
    '<p style="margin:16px 0 0;color:#8A7A67"><button ' +
    'onclick="location.reload()" style="font:inherit;color:#5C86B4;' +
    'background:none;border:0;border-bottom:1px solid currentColor;' +
    'padding:0 0 1px;cursor:pointer">再试一次</button></p>' +
    '</div></body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
