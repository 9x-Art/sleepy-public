# 窄修回交：groupOnline 迁移断言改为受控迁移检查（2026-10-04）

批准依据：用户 2026-10-04 第 7 条（处理 `behavior-online-migration-test` 中
本批新增的 groupOnline 迁移断言失败）。

**未覆盖 / 未重捕 / 未替换 v1 黄金基线**，**未把新增红项长期登记为已知过期**。

---

## 0. 施工前基线（校验值）

| 文件 | SHA-256 | 位置 |
|---|---|---|
| `scripts/behavior-online-migration-test.js` | `e645f61e9336e833fb80e739a48a949f2ff5438f7ed494f87f1dbf26338a612a` | `D:\projects\sleepy-baseline-20261004-b\` |
| `scripts/fixtures/behavior-baseline-v1.json`（**只读核对，未改**） | `25ccbbb8f00d210eabbcb91b967204d9ae52fabeff8eb2a85d9c5c140ba7f113` | 仓库内原位 |

窄修**未新增任何夹具**：`behavior-baseline-capture.js` 一字未改
（`git status` 中它是 `??` 未跟踪的新文件，本窄修未触碰）。
施工结束后 v1 基线校验值**复算未变**。

---

## 1. 改了什么（唯一被修改的文件：`scripts/behavior-online-migration-test.js`）

局部 unified diff 见附件 `mig-test.diff`（149 行）。三处：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `OTHER_CASES`（:733） | 移除 `'groupOnline'` → 它不再走 `strictOtherCase`，改走新增的 `strictGroupOnlineCase()`（:981 调用） |
| 2 | 新增 §9b（:811–935） | `strictGroupOnlineCase()` 三条断言 + `goBtBlock` / `goShellBlock` / `goSceneBlock` / `occurrencesOf` / `locateBlock` 五个辅助 |
| 3 | 调用点（:981） | `strictGroupOnlineCase();` |

### 为什么原判据必须换掉（不是降低强度）

`strictOtherCase` 判「与**未接线**的 v1 逐字段相同」。groupOnline 在 v161 批首次接线，
该判据在接线那一刻必然失效；更糟的是它**只在失效时报红** ——
若接线漏了 B/P/L、或把 groupRound 顶掉，它反而**全绿**（假绿）。
新判据把「该出现什么」显式写出来，比原来**更严**。

### 三条断言

1. **除 system 外每个字段与 v1 逐字一致**（接线不得外溢）
   把两边的 `messages[0].content` 都替换成占位符后跑 `diffPaths`，
   判据卡「除 system 外零差异」→ 接线若顺手改了 user 段 / entities / budget /
   sentinels / checks，这里必红。
2. **新增行为块完整、各仅一次、位置符合批准装配**
   - 期望块由**生产模块** `PROBE.S.behaviorText.module(id)` 导出并 `join('\n\n')`，
     **不是**从重捕结果里抠出来的（不把运行结果抄成期望值）。
   - `locateBlock` 要求整块**恰好命中 1 次**（整块比较，不是首句）
     **且其后紧跟 `\n\n`** —— 尾随分隔符是「按块移除」能成立的前提，不靠事后清洗兜。
   - 位置：`B/P/L` 起始偏移 **= 0**；`groupRound` 卡整块 1 次且夹在两者之间；
     `E/S4` 在 `[GROUP]` 之前。
3. **去掉新增块与装配分隔符后，剩余 system 与 v1 逐字一致**
   - **先**跑 `locateBlock`（完成性 + 次数 + 位置）与长度检查，**确认可移除之后才切**。
   - 移除 = 按**偏移量**切掉两处「块 + 其后分隔符」，长度由块本身决定：
     ```js
     var rebuilt = s.slice(0, iShell)
       + s.slice(iShell + shell.length + GO_SEP.length, iScene)
       + s.slice(iScene + scene.length + GO_SEP.length);
     ```
   - **未使用**宽泛正则、**未**删除所有匹配文本、**未**统一清洗空白
     —— 三者都会把真实差异一起抹掉，等于把判据关掉。
   - 逐字比对失败时报**首个差异字符下标 + 两侧上下文**，不截断、不归一。
   - 长度守恒断言：`原长 − 两块 − 2×分隔符 = 剩余长`（证明没多切也没少切）。

---

## 2. 负向验证（4 项，全部报红；跑完还原并核对无残留）

每次注入前备份 `page-group-ai.js` 与 `prompt-engine.js`
（`n2-*.bak`），**注入与跑测试分两条命令**。

| # | 注入 | 失败数 | 关键红点 |
|---|---|---|---|
| M1 | `E/S4` 截断为 40 字 | 9（+2） | `E/S4 整块 应恰好出现 1 次（整块比对），实得 0 次` ×2 |
| M2 | `B/P/L` 重复注入两次 | 9（+2） | `B/P/L 整块 …实得 3 次` ×2 |
| M3 | `groupRound` 卡正文被改 | 9（+2） | ①`groupRound 卡整块出现次数：期望 1，实得 0` ②`剩余 system 与 v1 不一致，首个差异在第 849 字符` |
| M4 | `user` 段（`messages[1]`）被加一行 | 8（+1） | ①`除 messages[0].content 外还有差异：实得 ["messages[1].content"]` |

**每项都由「该红的那条」抓住**，不是靠总数：
截断/重复 → 块完整性；卡被改 → 卡片完整性 + 逐字比对；
非 system 字段被改 → 外溢检查（此时两条 system 判据仍**正确地绿**，
因为 system 确实没被改 —— 说明三条判据各管一段，没有互相顶替）。

**还原核对**：`grep -E "M1:|M2:|M3:|M4:"` 无命中；
`diff` 与备份逐字一致（`page-group-ai.js` / `prompt-engine.js` /
`behavior-online-migration-test.js` 三份全一致）。

---

## 3. 失败集合逐项差分（不只比总数）

**窄修前 8 条** → **窄修后 7 条**。

**已消失（1 条，正是本批新增的那条）**
- `[groupOnline] 重捕与 v1 基线逐字段一致`

**新增（0 条）**

**保持不变的原有 7 条**（逐项核对，字符串完全相同）
1. `[offline] 重捕与 v1 基线逐字段一致`
2. `[groupOffline] 重捕与 v1 基线逐字段一致`
3. `[proactive] 重捕与 v1 基线逐字段一致`
4. `offline 装配仍用旧 shell / f2 / c05off（本批未迁）`
5. `sw.js CACHE 已按现有规则递增（v151 → v152）`
6. `各场景 capture scope 与边界与基线一致（不扩大为端到端）`
7. `捕获自检字段按真实采集语义给期望（不与请求正文混淆）`

> 第 4、5 条与本次窄修无关：CACHE 那条是脚本里写死的 `v151→v152` 旧断言，
> 早已过期；**按批准范围未修**。

**groupOnline 三条新断言全绿**：
```
✓ [groupOnline] 受控迁移：除 system 外每个字段与 v1 逐字一致（接线不得外溢）
✓ [groupOnline] 新增行为块完整、各仅一次、位置符合批准装配
✓ [groupOnline] 去掉新增块与装配分隔符后，剩余 system 与 v1 逐字一致
```

---

## 4. 测试结果表

| 套件 | 窄修前 | 窄修后 | 说明 |
|---|---|---|---|
| `behavior-online-migration-test` | **8 条失败** | **7 条失败** | 新增 1 条已消失，原有 7 条不变 |
| `pnpm check` | 126 ✓ / 0 ✗ | **126 ✓ / 0 ✗** | 全绿 |
| `pnpm smoke` | 618 ✓ / 0 ✗ | **618 ✓ / 0 ✗** | 全绿，82 脚本加载正常 |
| `browser-behavior-decision-test` | 40 / 0 | **40 / 0** | — |
| `behavior-offline-migration-test` | 67 / 0 | **67 / 0** | — |
| `browser-offline-f2-degrade-test` | 20 / 0 | **20 / 0** | — |
| `browser-offline-f2-degrade2-test` | 16 / 0 | **16 / 0** | — |
| `browser-offline-f2-degrade3-test` | 16 / 0 | **16 / 0** | — |
| `browser-offline-f2-req-test` | 34 / 0 | **34 / 0** | exit=0 |
| `browser-offline-f2-test` | 9 / 0 | **9 / 0** | — |
| `behavior-text-test` | 1 项失败 | **1 项失败** | **白名单既有失败，基线即红，按批准范围未修** |

**无任何新增问题。**

---

## 5. C1 注释修正（第 7 条）

`prompt-engine.js:207` 与 `sw.js:22` 原写「…与 shell ⑦「不输出完整内部计划」**并不冲突**」。
已改为：

> **本批不注入旧 shell 卡，因此未证明 shell ⑦ 构成本批接线的阻碍**
> （不注入 ≠ 已证明互斥不存在；真要注入需另行裁决）。

**只改注释，逻辑一行未动**（`injectShell: true, injectScene: true` 不变，
共享决策工厂未触碰）。两处一起改，避免 `sw.js` 留下同样的过度断言。

---

## 6. 附：本批生产文件相对**接线批施工前基线**的 unified diff

见附件：
- `diff-prompt-engine.diff` —— 3 处（spec 双 true + 注释；另两处纯注释）
- `diff-page-group-ai.diff` —— 4 处（内存诊断 / 入口重置 / 接线 / 末尾记账 + 导出）

要点：`prompt-engine.js` 的 `BT_SPECS.groupOnline` 双 `false → true` + 注释重写，
另两处是**纯注释**（`如 groupOnline` 举例已失真、overrides 里「未来开启」）；
`page-group-ai.js` 的 `parseRoundJSON` / `validateRound` / `saveInner` /
`saveDefer` / `innerText` / 投递链**一行未改**，**无新增 store 读写**。

---

## 7. 施工中我自己犯的两个错（如实记录）

1. **覆盖了自己的编辑版**。为对比「窄修前失败集合」，我先跑了一次编辑版存下
   失败集合，然后 `cp` 基线回去跑 —— 但**编辑版当时没有备份**，
   `cp` 失败（目录名写错）后我发现工作区已是基线态，编辑版丢失，
   只能按记忆重打三处编辑。
   教训：**动一个文件前先把它的新版也存一份**（我给 `page-group-ai.js` /
   `prompt-engine.js` 都存了，唯独漏了正在改的测试文件）。
   重打后校验值 `14fccea0…` 与重打前一致，并立即备份到
   `mig-fixed-BACKUP.js`。
2. **第一版判据用错了原语**。我用「按 `\n\n` 切段后整段相等」定位新增块，
   但 B/P/L 在 system 里是**三段独立元素**（`sys.push` 逐段推），
   `blocks.indexOf(shell)` 恒为 -1 → 两条断言假红。
   正确原语是**连续子串**（三段之间只隔 `\n\n`，整体构成一个连续块）。
   改成 `occurrencesOf` / `indexOf` 的子串定位后通过。
   教训：**判据的定位原语必须与被测对象的实际数据结构对齐**；
   「整块比对」的意图是对的，但「块」是连续子串还是数组元素，要先确认。

另：一次 `grep` 命中了 `groupOffline` 那条超长既有失败信息，输出被撑爆 ——
已改用固定脚本读文件并按 UTF-8 截断显示。

---

## 8. 未做（按第 8 条）

未改行为正文、协议、消费者、其他场景、共享决策工厂。
未调用真实模型、未提交、未 push、未部署。
**测试与注释修正未升缓存版本**（`CACHE` 仍为 `sleepy-v161`，
`smoke.js` 的 `EXPECTED_SW_CACHE` 未动）。
