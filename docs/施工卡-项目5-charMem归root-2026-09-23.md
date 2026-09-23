# 项目 5 施工卡：charMem 归 root + 迁移（2026-09-23）

> 依据：`docs/方案-第二批-最终施工设计-2026-09-23.md` §1（设计已定稿）+ 项目 1 已交付的三向边界。
> **本卡只讲"按什么顺序动手、每步怎么验、失败怎么退"**，不重复设计推理。
> 状态：**待开工**（本卡是方案，尚未改任何生产代码）。
> ⚠️ 行号是 2026-09-23 21:55 的实况；施工中会漂，**以函数名为准**。

---

## 0. 已定口径（施工依据，不再讨论）

| 项 | 定论 |
|---|---|
| 归属 | 长期记忆统一归 **rootId**；条目保留 `fromCharId` 记录"哪张脸产生的" |
| 回滚策略 | **备份源键，可精确回滚**（迁移前整份快照 `charMemBackup:<ts>`） |
| 键分组 · 归 root | `charMem` · `memoryIsland.byChar` · `charState` · `openLoops` · `attentionInbox` · `diaryPeek` |
| 键分组 · 按脸保留 | `charAppearance`（皮套级外观）· `charVoice` · `lifeShare`（用户对具体角色的日记授权） |
| 键分组 · 零迁移 | `diaryAuto`（写读本来就走 `activeCharOnIsland()` → root） |
| `charSettings` | `proactive` → root；`autoLife` → root；`memory` 停用（**旧值 false 要并入** `memoryIsland.byChar[root].enabled=false`），之后只认 memoryIsland |
| 冲突规则 | C1 全同跳过（幂等基石）· C2 败者改新 id + **统一 superseded** + `supersededBy` + 原状态进 `migrationOriginalStatus` · C3 失效优先 · C4 时间不可比留 root 侧 · C5 时间口径 · C6 `understandings` 未核实 schema → **不合并**（源键非空就整键不迁不删，隔离计数） · C7 锚优先 · C8 开关 false 优先 · C9 来源不明 → `fromCharId = null`（不猜） |
| 迁移事务 | 持久化 `charMemMigrationState`（txn / phase / backupKey / affectedRoots / status）；启动时发现未完成事务 → 未校验则整份恢复、已校验未删源则续完 |
| 写入锁 | 迁移期间暂停：总结写入、手工记忆写入、`sweepMem` |
| 清空 | 项目 1 已就绪：`migrationArtifacts` 清 `charMemBackup:*` + `charMemMigrationState` + 索引进度；`restoreArtifacts` 清恢复区 + 向量快照库 ✓ |
| 用户备份边界 | 项目 1 已就绪：`exportUserData()` 排除过程数据；`importAll` 忽略过程数据；`clearUserData()` 只清正式数据 ✓ |

---

## 1. 动手前请你拍两件事

### ① 提交 / 部署的顺序（建议：先把项目 1 收口）

**建议顺序**：项目 1 的改动 → 提交 + 部署 → 你在手机上把 **A1–A3** 验掉 → **再动项目 5**。

理由：A1–A3 要在**线上网页版**验，而项目 5 会继续改同一批文件（`memory-vec.js` / `page-backup.js` / `page-memory.js`）。
如果先做项目 5 再部署，线上就是"项目 1 + 项目 5 半成品"的混合体，A1–A3 的结论就不干净了。

> 另外提醒：部署上传的是**当前工作区文件**，会把**别的会话未提交的改动**一起发上去（工作区里除了我改的四个文件，还有几处我没碰过的 M）。要部署时告诉我按哪种方式发。

### ② DB 升级的真实后果：现有向量块**全部重建**

项目 5 要给块加 `fromCharId`，按项目既有约定（`DB_VER` 每升一次就 `deleteObjectStore` 重建）：

- **升级后旧块全没了**，游标也要跟着作废（`vecCursor3:` → `vecCursor4:`），否则"以为写过、索引永远空"。
- 后果：**升级后，历史聊天/日记/动态不会自动回到索引里** —— 只有新消息会被增量索引。

**所以要你定一个口径**：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 升级后**给一次「重建索引」的提示**（设置页一句话 + 一个按钮，点了从头顶重扫） | 一次性 embedding 费用/时间；用户自己决定什么时候跑 |
| B | 静默从头顶重扫（升级后自动跑） | 用户不知情就产生费用；大存档可能跑很久 |
| C | 什么都不做，只索引新内容 | 零成本；但**旧的聊天再也召不回**（可能被当成"记忆坏了") |

我倾向 A（可控、可见）。这条定了我再动手。

---

## 2. 锚点表（现状 → 改法）

### 2.1 读写的唯一入口（改这里，全链路跟着归一）

| 位置 | 现状 | 改法 |
|---|---|---|
| `page-memory.js:109` `charMemKey(charId)` | `'charMem:' + charId` | `'charMem:' + rootIdOf(charId)` |
| `page-memory.js:120` `loadCharMemory(charId)` | 直接用入参 key | 内部先 `root = rootIdOf(charId)`；返回的 file 上记 `rootId` |
| `page-memory.js:126` `saveCharMemory(file)` | 用 `file.charId` | 用 `file.rootId \|\| rootIdOf(file.charId)`；条目保留 `fromCharId` |
| `page-memory.js:90` `charConfig(charId)` | `byChar[charId]` | `byChar[rootIdOf(charId)]` |
| `page-memory.js:101` `setCharConfig(charId, patch)` | 同上写 | 同上；`level` 冲突按 C4 |

### 2.2 向量侧四判据（**必须同批改，改一半会静默打空召回**）

| 位置 | 现状 | 改法 | 不改的后果 |
|---|---|---|---|
| `memory-vec.js:247` `visibleTo` char 分支 | `return b.charId === charId` | `return b.charId === rootOf(charId)` | 开认知屏障后**皮套召不回自己的档案**（静默为空） |
| `memory-vec.js:1177` chat 块 `charId:` | `charId`（可能是皮套） | `rootOf(charId)` | 与上面不配套 → 永远匹配不上 |
| `memory-vec.js:1189` offline 块 | 同上 | 同上 | 同上 |
| `memory-vec.js:1341` 角色日记块 | `charId: cid` | `rootOf(cid)` | 同上 |
| `memory-vec.js:1381` mem 块 | `charId: charId` | `rootOf(charId)` | 同上 |
| `memory-vec.js:1448` phone 块 | `charId: charId` | `rootOf(charId)` | 同上 |

> 群池（`ownerKey: groupKey`）与岛池/账号池**不动** —— 它们本来就没有 charId 这一层。

### 2.3 其余四键的读写点

| 键 | 写 | 读 | 改法 |
|---|---|---|---|
| `charState:` | `page-summary.js:159` | `page-proactive.js:80`, `:228` | 写读都过 `rootIdOf` |
| `openLoops:` | `page-summary.js:167` | `page-proactive.js:78` | 同上 |
| `attentionInbox:` | `page-summary.js:170` | `page-proactive.js:76` | 同上 |
| `diaryPeek:` | `page-diary.js:619`（已 root） | `page-chat.js:668`（**脸**） | 读侧改 root → 修掉"写 root 读脸"那个现存 bug |
| `charSettings` | `page-chat-settings.js:215`；`phone.js:554/560` | `page-proactive.js:108`、`page-phone-ai.js` | `proactive`/`autoLife` 归 root；`memory` 停用并并入 memoryIsland |
| `lifeShare` | `page-chat-settings.js:355` 附近 | `life-feed.js:52`、`memory-vec.js:324` | **不动**（按脸） |
| `diaryAuto` | `page-diary.js:165` | 同 | **不动**（已 root） |

---

## 3. 分步施工（每步都能单独验、单独退）

### S1 单点归一：`charMemKey` / `loadCharMemory` / `saveCharMemory`

- **动**：`page-memory.js:109/120/126`。
- **改**：三处过 `rootIdOf`；`saveCharMemory` 给每条缺 `fromCharId` 的补 `fromCharId = 原 charId`（写入时能拿到就填，拿不到填 `null`）。
- **验**：T1（皮套写 → 读大号能读到、读皮套也能读到；键只有一个）。
- **退**：只改这一个文件的三处，回退 = git checkout 该文件。

### S2 开关按 root

- **动**：`page-memory.js:90/101`。
- **验**：T2（皮套里关开关 → 大号的 L0 注入为空；开关键只有一个）。
- **注意**：`isNpc` 判断要用 `rootIdOf(charId)` 判前缀，别用入参。

### S3 向量侧四判据对齐（2.2 的六行）

- **动**：`memory-vec.js:247` + 五处建块 `charId`。
- **验**：T3（建块后块的 `charId` 是 root；开屏障时皮套/大号都能召回；`sameModel` 不受影响）。
- **静态护栏**：`visibleTo` 里不得再出现裸 `b.charId === charId`（用 `rootOf`）。

### S4 块加 `fromCharId` + `DB_VER` 5→6 + 游标前缀换 4

- **动**：`memory-vec.js:63`（DB_VER）、`:1011`（`cursorKey` → `'vecCursor4:'`）、建块处补 `fromCharId`（= 原脸 id，没有则 `null`）。
- **验**：T4（块上有 `fromCharId`；游标前缀已换；升级后 `total()` 归零且不再报错）。
- **⚠️ 这一步就是 §1-② 的"块全部重建"** —— 口径定了再做。
- **退**：把 DB_VER 与前缀改回；旧块已被删（不可逆），但索引本来可重建。

### S5 `forget` 支持三维过滤

- **动**：`memory-vec.js:764` `forget(filter)`：`filter` 支持 `{charId, fromCharId, sandboxId}` 组合，逐条比较。
- **验**：T5（删皮套时只清 `charId=root && fromCharId=脸 && sandboxId=岛` 的块；同 root 的其他脸的块**必须留下**）。
- **为什么必须**：项目 4 的"删皮套/移出岛"要靠它精确清向量，不能误删整个 root 池。

### S6 其余四键归一（2.3 表）

- **动**：`page-summary.js:159/167/170`、`page-proactive.js:76/78/80`、`page-chat.js:668`、`charSettings` 三处。
- **验**：T6（皮套的 `charState`/`openLoops`/`attentionInbox` 与 root 同一份；`diaryPeek` 写 root 读 root）。
- **注意**：`charSettings.memory` 的旧 `false` 要**并入** `memoryIsland.byChar[root].enabled=false`，不能直接丢。

### S7 迁移：`migrateCharMemToRoot()`

- **动**：`page-memory.js` 新增迁移函数 + `charMemMigrationState` + `charMemBackup:<ts>`；在 `store` 的迁移序列之后、页面注册之前跑一次（照 `store.js` 里的幂等写法：跑过就返回 null）。
- **写入锁**：`charMemMigrationState.status === 'running'` 时，`saveCharMemory` 与 `sweepMem` 直接短路（返回 `{ok:false, why:'migrating'}`），总结流程跳过本轮。
- **验**：T7–T12（见 §5）。
- **退**：整份恢复（见 §4）。

### S8 启动恢复三分支

- **动**：`page-memory.js` 加载时读 `charMemMigrationState`：
  - `status='writing'` 且**未校验** → 用 `charMemBackup:<ts>` **整份恢复**（不是按 id 删）；
  - `status='verified'` 且**未删源** → 继续删源键、把状态推到 done；
  - `status='done'` → 清掉事务标记与备份（备份保留期见 §4）。
- **验**：T13（三个分支各造一次状态，断言走到对应分支且结果正确）。

### S9 文档 + 静态护栏

- **动**：`docs/交接-*` 加一节；smoke 加护栏断言（见 §5 末尾）。
- **验**：`check` + `smoke` 双绿。

---

## 4. 迁移流水线（六步，逐步可恢复）

```
① 读源键（characters 全表 + localStorage 前缀兜底捡孤儿键）
② 写 charMemMigrationState = {status:'writing', txn, affectedRoots}
③ 备份：charMemBackup:<ts> ← 所有将被合并/删除的源键 + 目标 root 键的**双份快照**
④ 合并写入 root 目标键（冲突按 C1–C9；understandings 非空则整键跳过并计数）
⑤ 校验：条目数量 / id / status / updatedAt / fromCharId / 去重结果
   ├─ 不通过 → 整份恢复（用 ③ 的快照）→ 状态 restored → 不删任何源键
   └─ 通过   → 状态 verified
⑥ 删源键 → 状态 done → 清事务标记
```

**幂等三条**：C1 全同即跳过；合并后删源键；中断重跑只走"跳过"分支 → 不产生副本。
**判据**：**旧源键删除前不算迁移完成**；失败**不删源键**。
**备份保留**：`charMemBackup:*` 保留最近 **3** 份（超过就删最旧的），且纳入项目 1 的「清空全部数据」（已就绪）。
**不做**："备份但永远保留源键" —— 那会形成两套活跃记忆。

---

## 5. 测试矩阵

| # | 断言 | 类型 |
|---|---|---|
| T1 | 皮套写 charMem → 大号读得到、皮套读得到、**键只有一个**（`charMem:<root>`） | 行为 |
| T2 | 皮套里关记忆开关 → 大号 L0 注入为空；`memoryIsland.byChar` 只有一个键 | 行为 |
| T3 | 建块 `charId` = root；开屏障时皮套/大号都能召回自己的档案；`sameModel` 不受影响 | 行为 |
| T4 | 块上有 `fromCharId`；游标前缀是 `vecCursor4:`；升级后 `total()` = 0 且 `open()` 不报错 | 行为 |
| T5 | `forget({charId, fromCharId, sandboxId})` 只清匹配块；**同 root 其他脸/其他岛的块必须还在** | 行为 |
| T6 | `charState`/`openLoops`/`attentionInbox` 皮套与 root 同一份；`diaryPeek` 写 root 读 root | 行为 |
| T7 | 迁移：皮套 charMem 并入 root；条目 `fromCharId` 正确；源键已删 | 行为 |
| T8 | 幂等：连跑两次 → 条目数不变、无副本、C1 全走跳过 | 行为 |
| T9 | C2：同 id 不同内容 → 新的赢、旧的改 id 且 `status='superseded'` + `supersededBy` 指向真实胜者 + `migrationOriginalStatus` 记原状态 | 行为 |
| T10 | C3：一边 active 一边 invalid → **失效优先**（不复活） | 行为 |
| T11 | `isAnchor` 冲突：锚优先，且**不改变失效状态** | 行为 |
| T12 | 孤儿键/来源不明：`fromCharId=null`，计入迁移报告；**不猜** | 行为 |
| T13 | 启动恢复三分支：未校验→整份恢复；已校验未删源→续完；done→清标记 | 行为 |
| T14 | 迁移期间写入锁：总结/手工写入/`sweepMem` 全部短路 | 行为 |

**反向验证（每条修复都要能变红）**：至少覆盖 S1（把 `rootIdOf` 去掉 → T1 红）、S3（`visibleTo` 改回裸比 → T3 红）、S4（前缀改回 3 → T4 红）、S5（去掉 `fromCharId` 比较 → T5 红）、S7（去掉 C3 失效优先 → T10 红）。

**静态护栏**：
- `page-memory.js` 里 `charMemKey` 必须过 `rootIdOf`；
- `memory-vec.js` 里不得出现裸 `b.charId === charId`；
- `cursorKey` 前缀必须等于当前 `DB_VER` 的配套值（防"升了版本忘换前缀"）。

---

## 6. 真机待验（node 验不了的）

1. **迁移在真实存档上跑完**：迁移前后条目数守恒、无副本、来源键真的删了（Console 里数 `charMem:` 键）。
2. **DB 升级后索引重建**：升级 → `total()=0` → 按 §1-② 选定的口径处理 → 新消息能重新建块。
3. **顺带把 B4-b 验掉**：DB_VER 5→6 正是 `onblocked` 的**真场景** ——
   两个标签页（一个有索引连接、一个跑新版）→ 应出现「向量库被另一个标签页占着」。
   **这是项目 5 附赠的一项验收，不用再改代码造场景。**
4. 迁移中途断掉（强关标签页）后重进 → 启动恢复三分支在真机上走通。

---

## 7. 本卡对应的交付物（施工完成后回交）

按你一贯要求的六项：**改动文件与行号 / 数据语义 / 是否需要历史迁移 / 新增测试 / 真机待验 / 失败回滚方式**，
每个 S 步骤单独报告一次。
