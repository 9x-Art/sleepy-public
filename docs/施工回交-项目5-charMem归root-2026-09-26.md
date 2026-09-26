# 施工回交：项目 5 charMem 归 root + 重建提示（2026-09-26）

> 依据：`docs/施工卡-项目5-charMem归root-2026-09-23.md` + `docs/方案-第二批-最终施工设计-2026-09-23.md` §2
> 口径确认：**DB 升级后重建索引选 A**（提示式，不静默全量重扫、也不放弃旧内容索引）。
> 状态：**S1–S9 全部施工完毕 + 五条补证完成，`pnpm check` + `pnpm smoke` 双绿，未提交、未部署。**
> 行号是 2026-09-26 补证收口后的实况。
> 补证结论速览：
> ① rebuildIndex 确实**每次调用都 resetCursors**（确认是 bug）→ 已修为仅首轮重置；
> ② migrateCharMemToRoot 此前 core 未就绪时**没有任何后续调用点**（确认是漏洞）→ 已接 DOMContentLoaded 二次调用链；
> ③ isMigrating 此前**不看持久化 state**（确认是漏洞）→ 已修，且失败路径按 §2.5 清 state；
> ④ T12 已补（块形状抽成纯函数 buildRecs 后可无 IDB 抽样断言）；
> ⑤ detectDbUpgrade 确实**会漏判**「旧库有向量但 localStorage 无痕迹」→ 已接 onupgradeneeded 权威信号兜底。

---

## S1 单点归一：charMemKey / loadCharMemory / saveCharMemory

- **文件**：`page-memory.js:123`（charMemKey 过 rootIdOf）、`:134`（loadCharMemory：root 门牌 + 补 rootId）、`:147`（saveCharMemory：归 root 门牌 + 补条目 fromCharId + 迁移写入锁短路）。
- **连带**：`page-summary.js:163` 总结写回改走 `M.saveCharMemory`（原来直写 `'charMem:'+charId`，会把 root 档案写到皮套键）；`calendar.js` 纪念日兜底读取也过 rootIdOf；`memoryStore` 新导出 `saveCharMemory`（群记忆拆库用）。
- **数据语义**：`charMem:<rootId>` 成为唯一键；条目缺 `fromCharId` 时按写入时的脸补，推不出填 null。
- **测试**：探针「charMem 归 root——同键共脑，条目记 fromCharId」（旧探针钉的「两键分裂」现状已被本口径作废，探针改写）；W19 场景一。
- **真机待验**：老存档加载后 Console 数 `charMem:` 键——迁移完成前皮套键还在（迁移负责删），迁移完成后只剩 root 键。
- **回滚**：见文末「回滚方案（专用）」——当前**没有经过验收的整体回滚路径，禁止直接按 git checkout 整体回退**（详见该节）。

## S2 开关按 root：charConfig / setCharConfig

- **文件**：`page-memory.js:100/112`；`isNpc` 用 root 判前缀。
- **测试**：W23（`memoryIsland.byChar` 归并后只剩 m23 一个键；皮套读开关读到 root 的）。
- **回滚**：见文末「回滚方案（专用）」——当前**没有经过验收的整体回滚路径，禁止直接按 git checkout 整体回退**（详见该节）。

## S3 向量侧判据对齐

- **文件**：`memory-vec.js` `visibleTo`（char/both 分支都按 `rootOf(charId)` 比对）+ 七处建块 `charId → rootOf(...)`：sweep / sweepOffline / sweepMoments / sweepDiary(char) / sweepMem / sweepPhone / reindexItem 三兄弟（refreshMoment/refreshMem/refreshPhone）。
- **施工卡外的一处必要扩展**：**朋友圈块也归 root**（施工卡 2.2 只列了五处）。理由：moments 是 `iso:'char'`，visibleTo 改按 root 比对后，皮套脸发的动态若仍记脸 id，屏障下**发它的那张脸自己都召不回**（比 old 行为还倒退）。
- **测试**：既有 L4 屏障用例照过；W19 探针 + W11 静态护栏（禁止裸 `b.charId === charId`）。
- **真机待验**：开认知屏障后，皮套能召回自己的档案 / 查手机 / 他发的动态。
- **回滚**：见文末「回滚方案（专用）」——当前**没有经过验收的整体回滚路径，禁止直接按 git checkout 整体回退**（详见该节）。

## S4 DB_VER 5→6 + vecCursor4 + fromCharId + 重建提示（口径 A 第 1–6 条）

- **文件**：`memory-vec.js:66`（DB_VER=6，升级即重建 vec store）、`:1099`（cursorKey → `'vecCursor4:'`）、`:1234/:1808` 等建块与 reindexItem 落 `fromCharId`、`blockerOne` 带出条目级 fromCharId。
- **重建机制**（`:2031-2280` 附近）：
  - `detectDbUpgrade()`（`:2078`）：模块加载即跑，幂等。`vecDbVer` 标记 + 「localStorage 里有 vecCursor/vecFail/vecEpoch 痕迹」判升级（配置过但没索引过的不算）→ 挂 `vecRebuild = {state:'needed', at}`；顺手清掉老前缀游标键。
  - **惰性基线**（sweepSource 内）：提示还挂着 + 游标不存在 + 不在重建中 → `baselineIndex(msgs, rebuildAt())`（`:2105`，纯函数）= 升级时刻之后的第一条。**旧历史一个向量都不算（不静默花钱）、也不承诺召回；升级后的新消息照常增量建块** —— 第 6 条。
  - `rebuildIndex(opts)`（`:2215` 起）：防重复点击（内存 `rebuilding` + why:'running'）；**首轮（needed）才 `resetCursors()`（世代号 +1 → 从头顶扫）；failed/running 的重试保留世代号与游标，从断点续扫**（`:2233`；clearFailures/clearCache 保留，退避和旧召回缓存仍要清）；按轮扫全源（chats / moments / diary / 每角色 mem+phone / 本岛线下会话 / 本岛群线上+群线下〔群线下经 `registerRebuildJob` 注册，行格式仍归 page-group-offline〕），**整轮零新增才算完**；成功 `store.remove('vecRebuild')` 提示消失；失败落 `state:'failed'` + 原因，**键不删 = 可重试入口保留**，重试从断点（游标）继续，不重复算向量（行为级证据见文末「第三轮收口」C 组）。
  - `sweepMem` 游标也归 root（`'mem:' + rootOf(charId)`），防皮套/大号双游标重复索引同一份档案。
- **UI**：`page-singleapi.js:488-548` `renderRebuild()`——「记忆索引需要重建」提示条 + 「重建记忆索引」按钮；running 显示轮数/新增段数并禁点；failed 显示原因 + 同一按钮即重试；成功后随 `renderList2` 刷新消失。`onProgress` 回调实时更新文案。
- **测试**：W18 六条（升级检出/提示存在、基线纯函数、cursorKey 配套 DB_VER=6、notneeded、成功清提示+世代号推进+重复点击被阻止、失败保留状态+同按钮重试走通）。
- **真机待验**：① 升级后 `memoryVec.total()===0`、设置页出现提示；② 不点重建发新消息 → 新块产生（增量没断）；③ 点重建 → 全量扫完提示消失、历史内容能召回（试试召回里能看到旧事）；④ 断网/断 key 点重建 → 失败提示出现，修好后同一按钮续扫。
- **回滚**：**代码回退保持 DB_VER=6 与 `vecCursor4` 不动**（本仓库已可能出现 v6 库；用 v5 打开会 VersionError，向量库从此打不开）。数据级回退（重建向量库）单列在文末「回滚方案（专用）」，不自动执行。

## S5 forget 三维过滤

- **文件**：`memory-vec.js` `forget(filter)`：支持 `{charId, fromCharId, sandboxId}` 组合，给了就必须**全中**；`fromCharId` 按块上字段（缺省 null）比对。
- **为什么**：项目 4 删皮套/移出岛要 `forget({charId: root, fromCharId: 脸, sandboxId: 岛})`，只按 root+岛会误删同 root 其他脸的块。
- **测试**：本步为 S9/W12 铺路；项目 4 施工时用 W12 类似断言（同 root 两张脸、同岛各造块 → 删 A 脸 → B 脸与别岛的块都在）。
- **回滚**：见文末「回滚方案（专用）」——当前**没有经过验收的整体回滚路径，禁止直接按 git checkout 整体回退**（详见该节）。

## S6 其余四键归一

- **文件**：
  - `page-summary.js:41`（本地 rootIdOf）+ `:167-175`（charState / openLoops / attentionInbox 写侧归 root）。
  - `page-proactive.js:27`（rootIdOf）+ `:72-82`（candidatesFor 三读）、`:235`（CONTACT_STATE 心绪读）。
  - `page-chat.js:666-674` diaryPeekMsg 读侧归 root（修掉「写 root 读脸」现存 bug——写侧 `page-diary.js:619` 一并按 root 递旗）。
  - `page-chat-settings.js:215-232` `charSettings()` 内部归 root（proactive/autoLife 读写一处收口）；**记忆开关写入方下线**：`:718` 起直接读写 `memoryIsland.byChar[root].enabled`（经 `memoryStore.charConfig/setCharConfig`，新导出）。
  - `phone.js:553-571` autoLifeOf/setAutoLife 内部归 root。
- **数据语义**：这些键从此只有 `*:<rootId>` 一种门牌；迁移负责把旧脸键并进来（S7）。
- **测试**：W23（memoryIsland / charSettings 归并、C8 false 优先、memory:false 并入 island.enabled）；S6 读写两侧的键一致性由「同 root 读到同一份」覆盖。
- **真机待验**：皮套里关记忆开关 → 大号 L0 注入为空；皮套总结产生的心绪在心绪面板按大号可见。
- **回滚**：见文末「回滚方案（专用）」——当前**没有经过验收的整体回滚路径，禁止直接按 git checkout 整体回退**（详见该节）。

## S7 迁移：migrateCharMemToRoot + 写入锁

- **文件**：`page-memory.js:494-770` 附近整段。七步流水线（§2.8）：
  `snapshot`（备份 `charMemBackup:<ts>` = 源键+目标键**双份完整快照**，state 含 sources 清单持久化）→ `merged`（C1 全同跳过；同 id 冲突 C2 同级按 updatedAt 新者胜 / C3 跨级失效优先；败者改新 id + `superseded` + `supersededBy` 指向真实胜者 + `migrationOriginalStatus`；isAnchor 只做字段 OR 不改状态；understandings 非空整键隔离不迁不删 C6；孤儿键不猜 C9；memoryIsland C8 false 优先 / level 按 C4；charSettings proactive false 优先、autoLife 保守取低档、`memory:false` 并入 `memoryIsland.byChar[root].enabled=false` 后摘字段；diaryPeek 搬旗）→ `verified`（数量守恒 / id 唯一 / supersededBy 可解析 / fromCharId 齐）→ `srcDeleted`（删源键）→ `done`（落 `charMemMigrated` 日志 + 清 state + 备份保留 3 份）。
  校验不过 → **用备份整份恢复** → 清掉 state → 不删任何源键（§2.5「结束（含失败）必须清 state」；审计留痕由 `charMemBackup:*` 承担）。
- **写入锁**（`page-memory.js:513-519`，两层）：`isMigrating()` = 内存锁 **或** `charMemMigrationState` 存在且 phase≠done（持久锁）——崩溃重启后的启动窗口里 migRecover 跑完之前，`saveCharMemory` 短路返回 `{ok:false, why:'migrating'}`（总结/手工写入全走它）、`memory-vec.sweepMem` 查 `MS.isMigrating()` 跳过本轮。
- **fromCharId 收口**：merge 时源条目按脸盖章，root 自身原有条目记自身 id。
- **测试**：W19 场景一/二（T1/T2/T2b/T3/T6/T3b + C8 + memory 并入）、W19 写入锁静态 + sweepMem 短路。
- **真机待验**：真实存档迁移前后条目数守恒、无副本；Console 数 `charMem:` 键只剩 root 的。
- **回滚**：见文末「回滚方案（专用）」——当前**没有经过验收的整体回滚路径，禁止直接按 git checkout 整体回退**（详见该节）。

## S8 启动恢复三分支

- **文件**：`page-memory.js:597` `migRecover(st)`；`migrateCharMemToRoot()`（`:587`）启动时自动跑（幂等：跑过返回 null）。**调用链**（`:828-850` `bootMigrate`，两条）：① 模块加载直喊；② core 未就绪 → 挂 **DOMContentLoaded**（defer 脚本全部就位的标准信号）再喊；事件已错过（readyState≠loading）→ 有界 setTimeout 重试（6 次 × 100ms）。行为级证据见文末「第三轮收口」D/E 组。
  - `snapshot`/`merged`/`failed` → 用 `backupKey` **整份恢复**（源键+目标键都还原）→ 清 state → 下次重跑；
  - `verified`/`srcDeleted` → 续完（删源键 → 落日志 → 清标记）；
  - done → 只清标记。
- **测试**：W19 场景三（三个分支各造一次，断言恢复/续完/收尾且 state 清干净）。
- **真机待验**：迁移中途强关标签页再进 → 走对应分支、数据无损（这是施工卡真机第 4 条）。
- **回滚**：同 S7。

## S9 文档 + 测试矩阵 + 双绿

- **测试**：`scripts/smoke.js` 新增/改写：
  - W18（重建六条 + vecCursor4 + 基线 + 防重复 + 成功清提示 + 失败可重试）；
  - W19（T1/T2/T2b/T3/T6/T3b/T7/T8/T9/T10/T11 核心断言，五个场景）；
  - W11 静态护栏 +3 条（charMemKey 过 rootOf、visibleTo 无裸比对、cursorKey 配套 DB_VER=6）；
  - 旧探针「charMem 归属」按新口径改写（同键共脑）。
  - 结果：**`node scripts/check.js` 全绿；`node scripts/smoke.js` 全绿（485 ✓ / 0 ✗）**。
- **未提交、未部署**（遵口径）。工作区改动文件：`memory-vec.js`、`page-memory.js`、`page-summary.js`、`page-proactive.js`、`page-chat.js`、`page-chat-settings.js`、`page-diary.js`、`page-group-offline.js`、`page-singleapi.js`、`phone.js`、`calendar.js`、`scripts/smoke.js`。
- **回滚**：见文末「回滚方案（专用）」——当前**没有经过验收的整体回滚路径，禁止直接按 git checkout 整体回退**（详见该节）。

---

## 施工卡之外的裁决记录（两处，都写了注释）

1. **朋友圈建块 charId 也归 root**（S3）：visibleTo 改按 root 比对后的配套，否则屏障下发动态的脸自己召不回自己发的动态。
2. **没落岛时重建跳过群级源**（S4）：群块要盖本岛的章，没章可盖宁可这轮不扫（增量侧 sweepGroup 本来就只在有岛时被喊）。

## 遗留 / 下一卡

- 项目 4（删除边界）消费 S5 的三维 forget（**forget 三维过滤本身已测**：纯函数 `forgetHit` 打表 + 生产路径行为级测试，见「第三轮收口」F 组；项目 4 只需补「删皮套/移出岛」的端到端场景）。
- 真机 B4-b（onblocked 双标签页）顺带可验：DB_VER 5→6 正是真场景。

---

## 补证与补测（2026-09-26 第二轮，验收前置；先查证后修改）

### 补证 1｜rebuildIndex 的 resetCursors 时序（memory-vec.js:2233）

- **查证结论：确实有 bug** —— 原 `:2212` 无条件 `resetCursors()`，失败重试会把第一轮写好的游标全部作废，已完成块重新算向量（双倍费用）。
- **修正**：`if (rec.state !== 'failed' && rec.state !== 'running') resetCursors();` —— 只有首轮（needed）从头顶扫；failed 重试保留世代号与游标，从断点续扫（clearFailures/clearCache 保留，退避和旧召回缓存仍要清）。
- **新增断言**（scripts/smoke.js:7700-7715 一带）：
  - needed 首轮：`vecEpoch` 5→6（推了一步）；
  - failed 重试：预置 `vecEpoch=9` + 断点游标 `vecCursor4:chatX={index:9,epoch:9}` → 重试后 `vecEpoch` 仍 9、游标仍在、`_pure.readCursor(...)` 仍返回 9（= m9 之前的块不会被重算）。

### 补证 2｜migrateCharMemToRoot 的真实调用链（page-memory.js:837-850）

- **查证结论：原来确实没有后续调用点** —— 模块加载时喊一次，core 未就绪返回 null 后整个启动周期无人再喊。
- **修正**：新增 `bootMigrate()`，两条链：
  ① 模块加载直接喊（`index.html` core.js:71 先于 page-memory.js:174，正常都就绪）；
  ② core 未就绪 → 挂 **DOMContentLoaded**（defer 脚本全部执行完的标准信号）再喊一次 `bootMigrate`。导出 `memoryStore.bootMigrate`。
- **新增断言**（smoke.js:7722-7734）：`rootIdOf` 置空调 bootMigrate → 返回 null、源键还在、done 标记没落（不许假装完成）；恢复 rootIdOf 再喊 → 迁移完成（源键删、root 键合并、done 落）。

### 补证 3｜启动恢复与写入锁时序（page-memory.js:513-519）

- **查证结论：确实是漏的** —— `isMigrating()` 只看内存锁，崩溃残留 `charMemMigrationState` 时、`migRecover` 跑完之前，`saveCharMemory`/`sweepMem` 都不挡。
- **修正两处**：
  - `isMigrating()` 增加持久化判据：`charMemMigrationState` 存在且 phase≠done → 即视为迁移中（`:518`）；
  - 配套把 migRun 校验失败路径改为**恢复备份后清掉 state**（`:805-808`，最终设计 §2.5「结束（含失败）必须清 state」原话）——否则 failed 状态常驻会让持久锁卡死整段会话的写入。审计留痕由 `charMemBackup:*`（保留 3 份）承担。
- **新增断言**（smoke.js:7736-7759）：预置 merged 残留 state → `isMigrating()` 立即为真；恢复期间 `saveCharMemory` 返回 `{ok:false,why:'migrating'}` 且不落库、`sweepMem` 返回 migrating；`migRecover` 跑完 → `isMigrating()` 放行、探针写入成功落库。

### 补证 4｜T12 七源抽样 + forget 三维（memory-vec.js:1111 / :863）

- **做法**：把「块记录形状」从 sweepSource/reindexItem 抽成纯函数 **`buildRecs(src, made, res, sid)`**（`:1111`，两处共用 `:1280`/`:1827`——两处各写一份迟早漂），把 forget 的命中判据抽成纯函数 **`forgetHit(b, filter)`**（`:863`）→ 冒烟无 IDB 也能抽样断言。两者经 `_pure` 导出。
- **forgetHit 维度语义（查证中发现的一个隐患）**：`charId` 维度**过 rootOf 归一**（语义「哪个大脑」——老调用方 refreshMem/refreshPhone 等传脸，不过归一会静默清 0 条）；`fromCharId` **精确**比对（语义「哪张脸」）；sandboxId/userId/groupId/sourceId/ids 精确。
- **新增断言**（smoke.js:7761-7809，真实 char m27/f27/f27b）：chats / offline / 朋友圈(角色发+我发) / 角色日记 / 我的日记 / 档案(有脸+null) / 查手机 / 群 十路抽样，逐路断言 `charId=rootId`、`fromCharId=真实来源脸`（群/岛我的动态/我的日记为 null）；forget `{charId,fromCharId,sandboxId}` 全中才删——别脸（f27b）、别岛（s2）的块必须留下；charId 传脸能归一命中；ids 维度参与全中。

### 补证 5｜detectDbUpgrade 漏判（memory-vec.js:148-172 / :2117）——第三轮复核修正

- **查证结论（两段）**：
  1. 启发式确实会漏判「旧 IDB 里有向量、vecCursor/vecFail/vecEpoch 痕迹不存在」的场景（浏览器清过 localStorage 而 IDB 还在等）→ 当全新装机 → 老块被升级行为静默清掉且永不提示；
  2. **第二轮的权威信号实现本身有 bug**：写的是 `req.oldVersion`，而 `req` 是 `IDBOpenDBRequest`——**`oldVersion` 在回调收到的 `IDBVersionChangeEvent` 事件上，request 对象没有这个字段**，`req.oldVersion` 恒为 `undefined`，判据永远为假（第三轮复核抓出，非笔误）。
- **现行实现（memory-vec.js:148-172）**：

```js
      /* onupgradeneeded 收到的是 IDBVersionChangeEvent —— oldVersion 只在
         **事件**上（IDBOpenDBRequest 本身没有这个字段…） */
      req.onupgradeneeded = function (event) {
        var db = req.result;
        var oldVer = (event && event.oldVersion != null) ? event.oldVersion : 0;
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        var os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('ownerKey', 'ownerKey');
        os.createIndex('at', 'at');
        if (oldVer > 0 && oldVer < DB_VER && !store.get(REBUILD_KEY)) {
          store.set(REBUILD_KEY, { state: 'needed', fromVer: oldVer, at: Date.now(), via: 'idb' });
        }
      };
```

  - `detectDbUpgrade` 结束时顺手 `open()` 一次（`:2117`，fire-and-forget），让升级信号尽早生效。
- **行为级验证**：`scripts/idb-upgrade-test.js` 场景 A/B（隔离内存桩库）——v5 旧库 + 空 localStorage → 升 v6、旧块清空、`rebuildState={needed, via:'idb', fromVer:5}`、`total()===0`；全新建库 oldVersion=0 不误报。**红测证明**：把实现临时改回 `req.oldVersion`（bug 写法）跑同一测试 → A3 变红（提示没挂上）。
- 静态护栏（smoke.js 补证5 两条）仍保留，但已不是唯一证据。

### 补证后结果

- `node scripts/check.js`：**全绿**；`node scripts/smoke.js`：**全绿（0 失败）**，新增 25 条断言（W20 块）。
- 仍未提交、未部署。改动文件在原 12 个基础上不变（补证只动了 `memory-vec.js`、`page-memory.js`、`scripts/smoke.js` 与本文档）。
- 回滚：见文末「回滚方案（专用）」——整体 git checkout 回退**未经验收、禁止直接执行**。

---

## 第三轮收口（2026-09-26，最终验收前；复核意见逐条落地）

### 一、oldVersion 取值核实（补证 5 的实现 bug）

- **完整 onupgradeneeded 回调**见上文「补证 5」引文（memory-vec.js:148-172）。
- `req` 的声明：`var req; try { req = global.indexedDB.open(DB_NAME, DB_VER); } catch (e) …`（`:146`）——是 `indexedDB.open()` 返回的 **IDBOpenDBRequest**。
- `oldVer` 的声明：回调形参 `function (event)`，`var oldVer = (event && event.oldVersion != null) ? event.oldVersion : 0;`——从 **IDBVersionChangeEvent** 读。第二轮写的 `req.oldVersion` 已删（request 上无此字段，恒 undefined，判据永远为假——本轮核实为真 bug）。
- **运行测试**（非字符串护栏）：`scripts/idb-upgrade-test.js` 场景 A/B，见下「测试结果」。
- **测试环境注明**：Node + 本文件内手写的内存 IDB 桩（事件契约对齐真 IDB：oldVersion 在事件上、request 上没有——正好能抓这类写法）；隔离测试库 = 桩内 `'sleepy-vec'`，每个场景独立一套桩与 localStorage 桩，**不读不写任何真实设备 / 浏览器存档**。跑法 `node scripts/idb-upgrade-test.js`（smoke 内经 spawnSync 拉起，见 smoke.js「补证6」）。

### 二、行为证据（全在 scripts/idb-upgrade-test.js，26 条断言全过）

- **C 组｜重建断点续扫**（二.1）：两场各 20 条消息的聊天；embed mock 对含 B 场文本的请求返回失败（失败的调用不计入成功计数）。第一轮 → A 场 2 块入库、B 场 0 块、`state:'failed'`；重试（embed 放行）→ A 场文本嵌入计数**不变**（断点之前的内容零重算）、B 场补完 2 块、`rebuildIndex` 返回 ok、`vecRebuild` 键删除（提示清除）。断言 C1–C9。
- **D 组｜DOMContentLoaded 真实事件链**（二.2）：`document` 桩 readyState='loading'；core 未就绪时加载 page-memory.js → bootMigrate 只挂监听不动数据；随后才设 core 与源键，**派发 DOMContentLoaded 事件**（不手动调 bootMigrate）→ 迁移完成（源键删、root 键合并、done 标记落）。断言 D1–D2。
  - **适用性说明**：当前加载方式是全部 defer，defer 脚本必然在 DOMContentLoaded **之前**执行完，所以 init 时刻事件一定未发生、链②天然适用。若未来改成动态注入导致事件已错过（readyState≠loading），bootMigrate 走有界 setTimeout 重试（6 次 × 100ms，core 就绪即迁）——E 组验证此兜底。
- **E 组｜事件已错过的兜底**：readyState='complete' + core 迟 200ms 就绪 → 800ms 内迁移完成。断言 E1–E2。
- **F 组｜三维删除走生产 forget 路径**（二.3）：隔离桩库布 4 块——B1(A脸+岛1, root 池)、B2(B脸+岛1)、B3(A脸+岛2)、B4(A脸+岛1, **岛池** `island:sb1`)。`forget({charId:r1, fromCharId:fA, sandboxId:sb1})` 恰删 1 块（B1）；B2/B3/B4 全在；再删 A+岛2 后只剩 B2/B4。纯函数 `forgetHit` 的既有打表保留（W20 补证4）。断言 F0–F4。
- 未为此重构任何无关模块：只新增了独立测试文件；smoke 内以 `spawnSync` 拉起并把退出码纳入断言（smoke.js「补证6」）。

### 测试结果（自动化）

| 套件 | 结果 |
|---|---|
| `node scripts/check.js` | 全绿 |
| `node scripts/smoke.js`（含 W20 + spawnSync 拉起 IDB 测试） | 全绿，0 失败 |
| `node scripts/idb-upgrade-test.js` | 6 场景 26 断言全过（A5/B2/C10/D2/E2/F5） |

### 回滚方案（专用）——第四轮改写：**回滚方案未验收，禁止直接按 git checkout 整体回退**

**为什么撤下「保留 DB_VER=6 + vecCursor4 即可随时回退、零数据操作」的承诺**：保持版本号只能保证**开库兼容**（库还能打开），它证明不了——

- 旧代码的 `charMem:<皮套>` 读写与新「归 root」的数据布局**不兼容**（旧逻辑会按脸另立门牌、读不到已归并的记忆）；
- 旧 `visibleTo` 按脸比对 vs 新块 `charId=root`（屏障下召回会静默为空）；
- 旧 forget 没有 `fromCharId`/`sandboxId` 维度（项目 4 的删除边界会误删整个 root 池）；
- `vecCursor4` 游标是给**新基线/重建逻辑**用的，旧扫描逻辑不认识 `vecRebuild` 状态机。

即：**没有经过验证的兼容回退版本**。整体回退 = 四套行为与数据互相咬合的机制退一半，风险不可控。本轮也不为此临时实现逆迁移。因此：

> **回滚方案未验收，禁止直接按 git checkout 整体回退。**

若验收不通过，处置顺序：① 就地修复（优先）；② 需要撤功能时，做**新版本的前向修复**（在 v6 基础上改行为），不做向后回退；③ 数据级的向量库清空单独走下面步骤。

**数据级操作（仅在确需清空向量库时，手动单步执行，不自动跑）**：

1. 确认聊天记录 / 留痕档案 / `charMemBackup:*` 迁移备份已在（这三样此操作**永远不碰**）；
2. 数据与备份页的「清空」→「向量库」步骤（`page-backup.js:187` → `memoryVec.wipeAll()`）只删索引块，不动存档；清空完成会自动挂 `vecRebuild={state:'needed', via:'wipe'}` 提示（memory-vec.js:549-554，见「第四轮」二）；
3. 之后是否「重建记忆索引」由用户决定——重建会重新产生 embedding 费用。

**绝不操作**：`chats` / `offlineSessions` / `charMem:*` / `charMemBackup:*` / `memoryIsland` / `charSettings`。

### 验收状态标注

| 项 | 报告核验 | 自动化通过 | 真机验收 |
|---|---|---|---|
| 补证1 重试断点 | ✓ | ✓（W20+IDB C 组） | 待验：真机断网重建→修复→续扫 |
| 补证2 迁移调用链 | ✓ | ✓（W20 补证2+IDB D/E 组） | 待验：真机冷启动迁移日志 |
| 补证3 写入锁时序 | ✓ | ✓（W20 补证3） | 待验：强关标签页重启无损 |
| 补证4/T12 七源抽样 | ✓ | ✓（W20 补证4+IDB F 组） | 待验：真机删皮套后召回面 |
| 补证5 oldVersion 权威信号 | ✓（实现 bug 已修） | ✓（IDB A/B 组 + 红测） | 待验：真机升级后提示出现 |
| S1–S9 主体 | ✓ | ✓（双绿） | 待验（施工卡 §6 四条） |

---

## 第四轮收口（2026-09-26，验收前最后补证）

### 一、回滚说明纠正

全文各节的直接 git checkout 回退建议已撤下，统一指向「回滚方案（专用）」；该节已改写为——**回滚方案未验收，禁止直接按 git checkout 整体回退**（理由：保持版本号只保证开库兼容，证明不了 charMem 归 root、向量 charId 归 root、fromCharId 删除边界、新游标与新扫描逻辑的兼容性；本轮不实现逆迁移）。详见上文改写后的「回滚方案（专用）」节。

### 二、「清掉索引」后的重建入口（核实 + 修复 + 验证）

- **实际调用链**：数据与备份页「清空」的六项之一「向量库」步骤 `vectorWipeStep()`（`page-backup.js:182-194`）→ `memoryVec.wipeAll()`（`memory-vec.js:519-560`）→ 清库 + `total()===0` 复核 → `resetCursors()`（`:539`，世代号 +1）→ `clearFailures()`（`:540`）。
- **核实结论：修复前没有任何人设置 `vecRebuild`** —— 第三轮回交文档里「清空后提示会按需重新出现」**是错的**，已改。已确认的 `vecRebuild` 写入点只有三处：`detectDbUpgrade`（启发式）、`onupgradeneeded`（权威信号 via:'idb'）、`rebuildIndex`（running/failed 状态流转）。
- **修复（保留该恢复路径）**：`wipeAll` 在复核通过且**确实清掉过块**（`clearedBlocks > 0`）时挂 `vecRebuild={state:'needed', via:'wipe'}`（memory-vec.js:549-554）——存档还在而索引被清的场景，历史恢复必须用户点头；存档一并清空的场景，重建扫不到东西、提示自动消。
- **隔离环境验证**（`scripts/idb-upgrade-test.js` G 组，9 断言）：布 v6 库 2 块 → `wipeAll()` 报 cleared 且挂 `via:'wipe'` 提示；**点击前**增量 sweep 基线挡住旧内容（嵌入计数 0，不静默重扫）；点击重建后 20 条消息重切 2 块、提示清除。未对任何真实存档执行清空。

### 三、原生 IndexedDB 验收（真系统 Edge + 真原生 IDB + 生产源码原文）

- **入口**：`node scripts/browser-idb-test.js`（playwright-core + 系统 Edge headless，一次性隔离 profile；本地 serve.js 起隔离测试站点，测试页 `preview/idb-test/index.html` 经同源 `<script>` 加载生产 `store.js`/`memory-vec.js` 原文；`preview/` 在 deploy 排除清单里不会上线；embedding 全程 mock，**不产生真实费用**；不读写用户真实浏览器存档）。可用 `IDB_SERVER_UP=1` 复用已起的服务。
- **实际结果：24 断言全过（4 组）**：
  1. 升级（原生1/1b，6 断言）：v5 旧库 + 无痕迹 → 升 v6、旧块清空、`via:'idb'` 提示；全新建库不误报；
  2. 重建断点（原生2，8 断言）：A 场 2 块成功后 B 场注入失败 → 重试 A 场文本嵌入计数不变（零重算）、B 场补完、提示清除；
  3. 三维 forget（原生3，4 断言）：删 A+岛1 恰删 1 块，B脸/岛2/岛池块全在；跨岛删除需在对应岛上下文操作（生产 `scanOwner` 按当前岛过滤的既有语义，如实记录）；
  4. 两标签页阻塞（原生4，6 断言）：旧连接占着时升级**不放行**（`available()` 挂起，Edge 未在 8s 内触发 onblocked——与施工卡 B4-b 预期的「弹占着提示」有出入，如实记录为行为差异）；旧连接关闭后升级自动继续完成（v6、旧块清空）；等待页重载后能看到 `via:'idb'` 重建提示（升级由先发起请求的页完成并写入，等待页重载后可见——store 内存缓存语义，与生产一致）。
- **桩与原生的关系**：`scripts/idb-upgrade-test.js` 保留，明确标注为「桩环境行为测试」（35 断言，含 G 组清索引恢复路径）；**桩结果不替代原生结果**，两层各自独立通过。

### 测试结果（三层自动化，本轮全部重跑）

| 层 | 套件 | 结果 |
|---|---|---|
| 静态/桩逻辑 | `pnpm check` | 全绿 |
| 桩逻辑 | `pnpm smoke`（含 W20 + 拉起桩 IDB 测试） | 全绿，0 失败 |
| 桩环境行为测试 | `node scripts/idb-upgrade-test.js` | 7 场景 35 断言全过 |
| **原生浏览器** | `node scripts/browser-idb-test.js`（Edge headless） | **4 组 24 断言全过** |

### 验收状态标注（四层）

| 项 | 报告核验 | 桩自动化 | 原生浏览器 | 真机 |
|---|---|---|---|---|
| 补证1 重试断点 | ✓ | ✓（W20+桩 C） | ✓（原生2） | 待验 |
| 补证2 迁移调用链 | ✓ | ✓（W20+桩 D/E） | —（纯启动链，无 IDB 交互面） | 待验 |
| 补证3 写入锁时序 | ✓ | ✓（W20 补证3） | —（同上） | 待验 |
| 补证4/T12 七源抽样 | ✓ | ✓（W20+桩 F） | ✓（原生3） | 待验 |
| 补证5 升级权威信号 | ✓ | ✓（桩 A/B+红测） | ✓（原生1/1b） | 待验 |
| 清索引恢复路径（本轮二） | ✓ | ✓（桩 G） | —（可并入下轮原生） | 待验 |
| 两标签页阻塞（本轮三.4） | ✓ | —（桩不建模多连接） | ✓（原生4） | 待验（B4-b 行为差异：挂起而非拒绝） |
| S1–S9 主体 | ✓ | ✓ | ✓（升级/重建/forget 面） | 待验（施工卡 §6） |

### 剩余真机项（唯一未覆盖层）

1. 真机（手机 PWA + SW 缓存环境）升级 → 提示出现 → 重建 → 历史召回；
2. 真机断网/断 key 重建失败 → 修复 → 续扫；
3. 迁移中途强杀页面 → 启动恢复三分支；
4. B4-b 行为差异确认：Edge 原生阻塞表现为「挂起后自动继续」而非「弹占着提示」——若要保留拒绝式提示，需另立 onblocked UI（本轮未做，如实待验）。
