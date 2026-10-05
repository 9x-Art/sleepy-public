# C1 定点核对：shell ⑦ 与 groupRound `plans[].internalUpdate`（只读 · 未施工）

> 日期：2026-10-04
> **本轮零改动**：未改代码、提示词、测试、文档；未调付费模型；未提交 / push / 部署。
> 目的：为「群线上是否可接共享行为层」提供裁决依据。

---

## ① 两处原文

### 1.1 shell 卡第 ⑦ 条

**文件**：`prompt-engine.js` · **行号 625–626**（`CARD_DEFAULTS.shell.body` 数组末两项）

```js
'[输出]',
'只输出 user 可见的角色回复和程序需要的短机器字段；不输出自由展开的内部推理或完整内部计划。'
```

同卡全文位置：`prompt-engine.js:366–400`（`shell: { title: '共享外壳 · 底线', locked: true, body: [...] }`）
七节依次为：`[身份与场景]` / `[角色声音]` / `[事实与可见性]` / `[主体性与责任]` / `[工具真实性]` / `[主动与节制]` / **`[输出]`**。

⚠️ **「短机器字段」在代码里没有任何字数定义** —— 全库只有这一处出现该短语（`prompt-engine.js:626`）。

### 1.2 groupRound 卡的 `plans[].internalUpdate`

**文件**：`prompt-engine.js` · **行号 912–943**（`CARD_DEFAULTS.groupRound`）

三处相关原文：

**（a）第 923 行 —— 调度项定义**
```js
'- action：group_reply（说话）/ observe（看在眼里，不说话，internalUpdate 记一笔）/ defer（现在忙，稍后处理）',
```

**（b）第 937 行 —— 输出结构模板（唯一出现处）**
```js
'{"plans":[{"entityId":"...","action":"group_reply|observe|defer","accountId":"...","intent":"一句话","publicPosture":"想表现出什么","internalUpdate":"observe/defer 时的心理注记","forbiddenDisclosures":["..."]}],"messages":[{"senderAccountId":"...","content":"...","delayMs":800}],"suggestContinue":false}',
```

**（c）第 917 行 —— 任务定义**
```js
'根据群成员、每个角色的设定与关系、本轮触发消息和近期群聊，先给每个候选本体一个行动计划（plans），再为行动者写出实际消息（messages）。',
```
紧接第 918 行：`'调度与发言分开想，但一次输出。'`

⚠️ **groupRound 卡对 `internalUpdate` 没有长度约束** —— 它只出现在 JSON 模板的示例值里
（`"observe/defer 时的心理注记"`），模板（第 937 行）里 `intent` 标了「一句话」而 `internalUpdate` **没标**。

---

## ② 调用链

### 2.1 群线上实际装配入口

| 环节 | 位置 |
|---|---|
| 对外入口 | `page-group-ai.js:584` 导出 `composeRound` |
| **装配函数本体** | `page-group-ai.js:182` `function composeRound(groupId, opts)` |
| system 第一段 | `page-group-ai.js:194` `sys.push(Sleepy.promptEngine.cardBody('groupRound'))` |
| 随后三段 | `205` `[GROUP]` · `229` `[ENTITY_KNOWLEDGE]` · `230` 编号禁令 |
| **实际发起调用** | `page-group-ai.js:409` 在 `runWave`（波次调度）内调 `composeRound` |
| 真实出站 | `page-group-ai.js:423` `Sleepy.api.requestOnce(cand, round.messages, {})` |

**源码已证实**：`composeRound` 是群线上唯一的 system 装配入口；
`groupRound` 卡是它的第一段；**shell 卡完全不在群线上**（全库无 `cardBody('shell')` 出现在 `page-group-ai.js`）。

### 2.2 `internalUpdate` 的完整链路

```
【生成】模型输出 plans[].internalUpdate
   ↓  page-group-ai.js:428  parseRoundJSON(res.content)
【解析】JSON.parse 后取 parsed.plans（:430 validateRound 内 plans.forEach）
   ↓  ⚠️ validateRound 完全不读 internalUpdate —— 它只校验 entityId/action/accountId/content/delayMs
   ↓  page-group-ai.js:449  deliver(valid, parsed) 取 plans
【落库】:450  saveDefer(groupId, plans)  → action==='defer' 时取 internalUpdate，截 120 字
        :451  saveInner(groupId, plans)  → 每个有 internalUpdate 的 plan 截 120 字存 map
        存储键：'groupInner:<groupId>'（innerKey，:46） / 'groupPending:<groupId>'（pendKey，:45）
【消费】:87   innerText(groupId, ownerId) 读 map[ownerId]
        :210  composeRound 里逐实体拼进 [ENTITY_KNOWLEDGE]：
              '上一轮你没说出口的念头（还热着，可以自然带出来，也可以继续压着）：' + inner
```

### 2.3 已证实 vs 待运行验证

**源码已证实**：

1. `internalUpdate` **不进 `messages`** —— `validateRound`（:294）只从 plans 取 `entityId` / `action` / `accountId` 决定「谁获准发言」，`messages` 只经 `senderAccountId` / `content` / `delayMs` 三字段。
2. `internalUpdate` **不被校验** —— plans 里缺它、多它、写错类型都**不会**导致 `validateRound` 失败（它根本没被读）。
3. **落库时被截到 120 字**（:54 / :66 的 `slice(0, 120)`）—— 超长部分**直接丢弃**。
4. **消费时是逐实体的、无标签的自然语言**（:211），拼进该实体的 `[ENTITY_KNOWLEDGE]` 块。
5. **注入即清只对 `[PENDING]` 成立**（:79 `store.set(pendKey, [])`）；`innerText` 是**常驻**（无清空逻辑），下一轮继续带。
6. **`[LAST_ROUND_INNER]` 这个字面量在生产代码里不存在** —— 只出现在 :42 的注释里；实际注入（:211）**没有任何标签**，是裸的「上一轮你没说出口的念头…：<内容>」。相比之下 `[PENDING]` 有真实字面量（:268）。

**尚待运行验证**：

1. 模型实际会不会把 `internalUpdate` 写长（**卡里没有长度约束**，只有程序侧 120 字截断）。
2. 写长时模型是否同时在 `messages` 里展开内心独白（程序侧无法拦 —— `messages.content` 不做长度/内容校验）。
3. shell ⑦ 与 groupRound 同时在场时，模型是否**真的**因为 ⑦ 而不填 `internalUpdate`（纯推断，无证据）。
4. `validateRound` 校验失败时的重试（:432）是否会让模型补全 `internalUpdate`。
5. `innerText` 常驻（无清空）时，`internalUpdate` 跨多轮累积的实际表现。

---

## ③ 究竟在哪个要求上冲突

### 3.1 `internalUpdate` 是结构化状态，不是「详细内部推理」

**证据 1 —— 卡里的定位**：`'internalUpdate':"observe/defer 时的心理注记"`（:937）
是**一个字段的值**，与 `intent`（`"一句话"`）、`publicPosture`（`"想表现出什么"`）、
`forbiddenDisclosures`（数组）**并列**，同属 plans 的结构化字段。

**证据 2 —— 卡的调度语境**（:923）：
`observe` 的定义是「看在眼里，不说话，**internalUpdate 记一笔**」
—— 「记一笔」明确指向**简短状态记录**，与 `intent` 的「一句话」同一量级。

**证据 3 —— 程序侧截断到 120 字**（:54 / :66）
若它被当作「详细内部推理」，120 字截断会破坏语义；截断本身说明
**程序侧从设计起就把它当短状态**。

**证据 4 —— 它不进 messages**（`validateRound` 不读它）
若模型真要输出详细推理，输出通道应是 `messages[].content`（那里才是给用户看的），
而不是一个旁路字段。

### 3.2 真正冲突的要求

**不是**「要不要输出内部推理」—— 两边都反对冗长推理。
**而是这两条：**

| 出处 | 要求 |
|---|---|
| shell ⑦ | 「只输出 user 可见的角色回复**和程序需要的短机器字段**」 |
| groupRound :937 | `plans` 里**必须**有 `internalUpdate` 字段（JSON 模板含该键） |

**冲突点精确表述**：
shell ⑦ 允许「程序需要的**短**机器字段」，`internalUpdate` 是程序需要的字段
（`saveInner` 会读它）—— **单看「程序需要的机器字段」这半句，不冲突**。

⚠️ **真正的张力在「不输出……完整内部计划」这半句**：
`plans[]` 整体是一份**行动计划**（`entityId` + `action` + `accountId` + `intent` +
`publicPosture` + `internalUpdate` + `forbiddenDisclosures`），
`internalUpdate` 是其中「记录这个本体此刻心理状态」的一项。
shell ⑦ 的「不输出完整内部计划」**字面上覆盖 plans 全体**，
而 groupRound **硬要求** plans 存在且字段齐全（（:938「plans 覆盖全部候选本体（包括不说话的）」））。

**所以冲突是：shell ⑦ 禁止「完整内部计划」，groupRound 强制要求一份完整 plans。**
`internalUpdate` 只是这个冲突里最容易被模型拿来「写内心戏」的那一项，
但冲突**不局限于它**。

### 3.3 为什么我上一版把它写成「硬冲突」是过度断言

我在方案 §4.3 写的「注入后可能让群聊整轮不发消息」是**推断**，无证据：
shell ⑦ 与 groupRound 卡**不在同一张卡里**（shell 在 `CARD_DEFAULTS.shell`，
groupRound 是另一张），模型是否会跨卡对齐这两条要求、
是否会因一条而放弃另一条，**必须实跑才知道**。

准确表述：
> **要求层面存在字面冲突**（⑦ 禁 plans / groupRound 强制 plans）；
> **运行层面是否真的互相排斥，未验证**。

---

## ④ 保留现有协议的最小兼容方案

### 4.1 建议方案：**不改任何卡，为群线上做 shell ⑦ 的「场景例外」**

| 项 | 做法 |
|---|---|
| `CARD_DEFAULTS.groupRound` | **零改动**（协议、字段、模板全保留） |
| `CARD_DEFAULTS.shell` | **零改动**（线上/线下仍在用） |
| 新增 | 群线上**不注入整张 shell 卡**；若要注入，只注入 shell 的**前六节**，跳过第 ⑦ 条 |
| `btDecide` 侧 | `BT_SPECS.groupOnline` 保持 `injectShell:false`，**本批不接线**（现状） |

**理由**：`internalUpdate` 已被证实是「程序需要的短机器字段」，
而 shell ⑦ **本身就允许**「程序需要的短机器字段」。
真正冲突的只是 plans 全体与「不输出完整内部计划」这半句，
**而 plans 是 groupRound 的硬协议、不能动**。

### 4.2 若一定要注入 shell，可选的最小侵入做法

**做法 A（推荐）：给 shell 加一个「场景例外」机制**
```
shell ⑦ 在群线上不适用 —— 群聊一轮的调度结构由 groupRound 卡规定，
其 plans[].internalUpdate 是程序需要的短机器字段（≤120 字，注入逐实体知识块）。
```
实现上：shell 的 `[输出]` 一节拆成两句，⑦ 只在非群聊场景注入。
⚠️ 这需要 `btDecide` 支持「按场景裁掉某几节」，属**新功能**。

**做法 B（不推荐）：改 groupRound 卡加一句澄清**
在 `【输出结构 · 硬约束】` 前加「本卡要求的 plans 属于程序需要的短机器字段，不算内部计划输出」。
⚠️ 属于**改提示词**，你本轮明确不动。

**做法 C（最保守）：群线上永不接 shell，仅在诊断里记「未接线：B/P/L/E/S4」**
即维持现状。代价是群线上三个角色（NPC 不在场/不调用/不越权）拿不到共享外壳。

### 4.3 可能受影响的消费者

| 消费者 | 位置 | 受影响条件 |
|---|---|---|
| `saveInner` → `innerText` → `[ENTITY_KNOWLEDGE]` | `page-group-ai.js:61/87/210` | **不受影响**（不碰 plans 协议即不动这条链） |
| `saveDefer` → `[PENDING]` | `:48/268` | 不受影响 |
| `validateRound` | `:294` | 不受影响（不读 internalUpdate） |
| `parseRoundJSON` | `:285` | 不受影响 |
| 群线上 `observe` / `defer` 行为 | `:923` 卡的 action 定义 | **若裁掉 shell ⑦，observe 的「记一笔」照常** |
| 私聊线上 shell 位 | `prompt-engine.js` assembleOnline | **必须零改动**（方案 A/B 都只影响群线上） |
| 私聊线下 shell 位 | 同上 | 必须零改动 |

**结论**：只要**不碰 `groupRound` 卡**、**不碰 `validateRound`/`saveInner`**，
这条链完全不受影响。

### 4.4 验收点（等裁决后才需要跑）

| # | 验收点 | 判据 |
|---|---|---|
| 1 | shell 注入不降低 `plans` 完整率 | 真实请求下 `plans.length` == 候选实体数（:938 要求） |
| 2 | `internalUpdate` 仍有值 | `saveInner` 落库非空（`groupInner:<id>` map 非空） |
| 3 | **不出现 messages 里展开内心戏** | 人工看 `messages[].content` 有无大段心理描写 |
| 4 | `internalUpdate` 长度分布 | 统计是否大量逼近 120 字截断（逼近 = 模型在写长） |
| 5 | 回归：线上/线下 system 不变 | `assembleOnline` / `assembleOffline` 的槽位快照逐项一致 |
| 6 | 回归：群线上原有行为不变 | `validateRound` 通过率、`[PENDING]` 注入正常 |
| 7 | 诊断口径 | `wired` 字段能区分「未接线」与「部分接线」 |

⚠️ **1、3、4 需要真实模型**（付费）。2、5、6、7 可用桩完成。

---

## ⑤ 待裁决

| # | 问题 |
|---|---|
| 1 | 群线上是否接 shell？接的话选做法 A（加场景例外）还是 C（维持不接）？ |
| 2 | 若接 A，`btDecide` 要新增「按场景裁掉 shell 某几节」的能力 —— 这算新功能，是否批准？ |
| 3 | 方案 §4.3 里我写的「注入后可能让群聊整轮不发消息」是**推断**，是否要在下一版文档里改成「字面冲突、运行影响未验证」？ |

**本报告只交证据与建议，未做任何施工。**
