# Sleepy · 专项勘察（ta-life 消费语义 / 群线上缺失槽 / confirmedChange 丢失链）

> 只读勘察，零模型请求、零网络、未改生产文件。HEAD = `c327cf5`。
> 动机：你的判断「ta 是用来补充人设饱满度的，应该意味着需要进入消费端」——本文用源码验证这个直觉哪些成立、哪些有结构性空白。

---

## 一、ta-life 三表：有没有产品设计上的聊天消费语义？

### 1.1 事实底座

**ta-impact 与三表零读写关系**（`ta-impact.js` 内 `taItems/taPromises/taFollows` grep 零命中）。当前 ta 数据分两套并行：

```
ta-life 三表（taItems / taPromises / taFollows）
   ├─ 消费 ①：ta 首页展示（page-ta）
   └─ 消费 ②：ta-proposal 提案目标池（item_update / follow_update / promise_review，
              用户接受后 patch 三表，history 留痕）—— ta→ta 自循环

taEvents（ta-impact 独立持有，store key 'taEvents'）
   ├─ 生产 ①：ta-proposal 的 npc_event 类提案被用户接受后写入
   ├─ 生产 ②：NPC 事件（page-ta 登记）
   └─ 消费：impacts 经三道闸（知情×有效×相关）→ K03d 槽 → 进聊天层 ✅
```

### 1.2 设计稿怎么说

`docs/勘察-ta首页-2026-10-02.md`：三表的产品依据是「每个首页对象都能回到同源记录」
（§4 缺口清单），一句话目标「先让 ta 稳定展示**已经成立的生活**」。
**设计稿通篇没有「三表进聊天 prompt」的明文** —— 即：三表不进聊天层**不是「设计了没做」，
而是设计空白**。v1 施工定位是 0 模型调用的展示层。

### 1.3 对你直觉的验证：一半成立，且有结构性依据

你的直觉「ta 补人设饱满度 ⇒ 该进消费端」**在人物运行层（P）的语义下成立**：

- P 原文要求「已知且有效的生活影响，先经过人物自己的理解，再进入**精力、注意力、话题与行动**」。
- 三表内容（进行中的事项 / 没兑现的承诺 / 持续的关注）恰恰是「精力、注意力、话题」最具体的素材——
  「他那个修了半个月还没修好的相机」「答应周末陪拍照还没兑现」「一直在喂的楼下的猫」。
- 当前聊天层只能通过 **K03d impacts** 间接感知这些生活（且 impacts 是「变化带来的影响」，
  需用户确认 + 三道闸，覆盖面**窄于**三表本体）——「持续进行中的状态」没有稳定入口。

### 1.4 若要接，设计上要过哪些闸（不施工，只列边界）

| 闸 | 说明 |
|---|---|
| 知情 | 三表 `refCharId` 归 root（皮套与大号共享同一段生活）——「角色自己的生活」天然知情 ✅ |
| 状态时效 | 三表有状态五态闭集 + `nextCheck`，注入时应带状态、只注非「已完成」 |
| 不自相矛盾 | 三表状态靠用户手动/提案维护，可能与聊天内容漂移 ⇒ 注入宜用「背景清单」口径（同 K03d 的「只作背景，不强迫提及」） |
| 承诺红线 | 「承诺绝不自动判兑现」——注入侧也不得表述成「已完成」，只给 `quote + status + pendingWhy` |
| 容量 | 三表可多，注入需截断（建议各 ≤2 条，进行中优先） |

**结论**：三表进聊天层有真实的语义价值（P 层的「精力与注意力」素材），但它是**新增设计决策**，
不是补既有设计——需要你拍板后再立施工单。最自然的接入形态是仿 K03d 开一个
「进行中的生活」program 槽（或并入 taimpact 槽文本），线上/线下/主动三场景适用。

---

## 二、群线上缺失的共享信息：哪些被替代，哪些真没接

逐槽对照私聊线上（`prompt-engine.js` ONLINE_SLOTS），群线上 system 实际只有：
**B/P/L → groupRound 卡 → E/S4 → [GROUP] → [ENTITY_KNOWLEDGE] → 编号禁令 → 历史**。

| 私聊线上槽 | 群线上现状 | 判定 |
|---|---|---|
| K01 角色核心 | [ENTITY_KNOWLEDGE]：人设（1200 截断）+ charMetaLines 短字段 + NPC knownBy | ✅ **被替代**（逐本体，含共享人物层） |
| C01-C03 共享外壳 | B/P/L 直接进（v161 裁决：不注入旧 shell 卡、不做裁节） | ✅ **被替代**（冻结正文顶替旧卡） |
| C04 F1 | E/S4（行为层）+ groupRound（群协议） | ✅ **被替代** |
| C05 输出协议 | groupRound 自带【输出结构 · 硬约束】（plans + messages） | ✅ **被替代** |
| K03c 向量召回 | **群池 groupTextFor**（`:263-264`，逐本体内联、按记忆开关隔离） | ✅ **被替代**（群版 L4） |
| K03 关系 | pairRelText 两两关系（实体知识内）+ innerText（上一轮没说出口的念头，120 字） | ⚠️ **部分替代**（本体间关系有；无 [U→C] 归档记忆层、无对 user 的关系） |
| K02 user 马甲 | [GROUP] 只给「user 的账号」标签，**马甲人设没进** | ❌ **未接** |
| I01 马甲认知 | 无（groupRound 只有一句「多账号共享意识与记忆」管本体侧；user 马甲认知、大小号边界没有） | ❌ **未接** |
| I02 时间事实 | 无（grep `clockTime/timeFacts` 零命中）——群里角色不知道「现在几点」 | ❌ **未接** |
| I03 语言 | 无 [LANGUAGES]（群**线下**有，群线上没有）——多语言角色在群里说母语无依据 | ❌ **未接** |
| K03b 近期生活 | 无（lifeFeed 零命中） | ❌ **未接** |
| K03d 已成立影响 | 无（taImpact 零命中） | ❌ **未接** |
| K04 世界书 | 无 | ❌ **未接** |
| K/S 自定义卡 | 无 | ❌ **未接** |

**汇总**：核心叙事层（人物/行为/协议/群检索）齐了；**「时间、语言、user 马甲与认知、
生活动态、ta 影响、世界书、自定义卡」七类共享信息真没接**。
其中影响最大的是 **I02 时间**（群聊「我刚下班」「这么晚了」全靠猜）与
**I01/K02**（user 的马甲与大小号边界在群里的认知语义是空白，而群聊恰恰是马甲最容易露馅的场景）。

> 参照系：群线下（c327cf5 后）的共享信息比群线上**更全**——有 [LANGUAGES]、
> [PRESENCE RULES]（含文风/在场状态）、[PARTICIPANTS] 逐参与者人设+群池。
> 两个群场景的共享信息水位不一致，是接线下 vs 接线上两批的取舍差异，值得一张对齐施工单。

---

## 三、confirmedChange：生产来源、预期消费者、丢失位置

### 3.1 生产者

**总结卡**（`CARD_DEFAULTS.summary`，locked，`prompt-engine.js:1003`）
【关系状态与推动意向】段要求总结模型输出：

```
relation: { confirmedChange（只有明确双方共识的关系事实才填写）,
            currentReading（角色当前理解，主观）, evidence, sourceIds,
            intent: { direction: "maintain|closer|repair|step_back|hold",
                      pace: 1~5, nextAction, requiredSignal, avoid, validUntil } }
```

同卡还有 `review`（互动表现评估）与 `uncertain`（不确定项，卡上写「模型看不准时**必须**写入」）。

### 3.2 消费者现状（丢失位置）

`page-summary.js:58-126 summaryEngine.ingest` 的字段白名单只有四个：

| 总结卡字段 | ingest 是否消费 | 落点 |
|---|---|---|
| `changes` | ✅ | memoryStore 入库（K03 → 进 prompt） |
| `charState`（feelings/readings/unspoken） | ✅ 存 `charState:<rid>` | page-proactive 候选合成（attention > openLoops > unspoken）+ page-ta 首页 |
| `openLoops` | ✅ 存 `openLoops:<rid>` | page-proactive + page-ta |
| `attention` | ✅ 存 `attentionInbox:<rid>` | page-proactive + page-ta |
| **`relation`（含 confirmedChange / currentReading / intent）** | ❌ **零消费** | **产出即丢弃** |
| **`review`** | ❌ **零消费** | **产出即丢弃** |
| **`uncertain`** | ❌ **零消费** | **产出即丢弃** |

**丢失位置就是 `ingest` 的字段白名单**：模型按卡的要求付了钱（token）产出这三个字段，
程序在解析入库那一步直接没接。

### 3.3 预期消费者本来是谁（卡内文字给出的线索）

- `intent.nextAction / requiredSignal` 卡上明写「**不在界面展示给 user（剧透保护）**」
  ⇒ 设计意图是给**程序侧**消费——最自然的落点是**主动消息候选合成**
  （page-proactive 已接 attention/openLoops/charState，唯独 intent 没有落点）；
  `requiredSignal`（期待的信号）天然是「下次接触时观察什么」的输入。
- `confirmedChange`（双方共识的关系事实）⇒ 预期落点是**记忆库**（relationship_fact 类）
  或关系层（core.js 的 charRel）——但「双方共识」需要 user 侧确认闸，不能像
  charState 那样静默入库。
- `uncertain` ⇒ 最轻的消费是诊断/调参视角（哪些输入总让模型看不准）。

### 3.4 修复面估计（不施工）

最小修 = `ingest` 增加三个 `store.set`（`relationIntent:<rid>` / `reviewLog:<rid>` /
`uncertainLog:<rid>`）+ 键登记 + 消费侧另立批次（intent → 主动消息候选的一个来源）。
注意 `confirmedChange` 若要生效，**必须过 user 确认闸**（卡上语义就是「共识才填」，
静默入库会违反「记忆变更提案 confirm:true 需 user 确认」的同族纪律）。

---

## 四、一句话总结

1. **ta-life 三表**：设计上没有聊天消费语义（设计空白，不是漏做）；但按人物运行层 P 的
   语义它们正是「精力与注意力」素材，接入有真实价值——**要不要进、以什么形态进，等你拍板**。
2. **群线上**：叙事核心层齐了（全靠 groupRound + [ENTITY_KNOWLEDGE] + 群池替代）；
   **时间 / 语言 / user 马甲与认知 / 生活动态 / ta 影响 / 世界书 / 自定义卡七类真没接**，
   其中 I02 时间与 I01/K02 认知是群聊场景里最疼的两个。
3. **confirmedChange**：生产者 = 总结卡，丢失位置 = `summaryEngine.ingest` 字段白名单
   （relation / review / uncertain 三字段产出即丢弃）；同族字段 charState/openLoops/attention
   都有消费者（主动消息 + ta 首页），唯独 relation 系列无落点 —— 修入库易，修消费需先定
   intent 的程序侧用途与 confirmedChange 的确认闸。
