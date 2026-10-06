# 方案 · HTML 小游戏（char 发可玩网页）v1

> 落地日期：2026-10-06　状态：**收口完成，待真机浏览器验收（云浏览器额度中断）**
> 关联 SW 跳版本：`sw.js` v187→v188
> 改动文件：`prompt-engine.js` / `page-chat.js` / `core.js` / `style.css` / `scripts/smoke.js`

## 1. 能力是什么

char 在回复里写一块 `[html]…[/html]`，里面是**完整内联 HTML**（CSS/JS 都内联），
程序剥掉标签 → 落成 `type:'html'` 消息（`html` 字段存源码）→ 沙箱 iframe 渲染成一个可玩的小游戏。
点「全屏」进独立浮层游玩。游戏结束时通过桥上报结算，下一轮对话 TA 能自然接话（调侃/约再来一局）。

## 2. 链路

```
回复 [html]…[/html]
  → prompt-engine.parseReply 切气泡（|| 不切碎，splitBubblesT 用 ' || ' 重拼）
  → page-chat.extractHtmlGames 剥标签、抽源码      [chatUtil 导出]
  → commitHtmlGame 落库 type:'html'               [addMessage 前抽，title 取 <title>]
  → 渲染 htmlGameCard → 沙箱 iframe（srcdoc = wrapGameDoc）
  → 游戏内 SleepyGame.report(score, text)
      → postMessage {__sleepyHtmlResult:1,...}
      → 父页只认 registerGameFrame 登记过的窗口（gameFrameWins）
      → noteGameResult → store.htmlGameResult:<chatId>
  → 下一轮 gameResultPeekMsg 读出即摘，垫进上下文
```

## 3. 安全模型（这条别动）

- `sandbox="allow-scripts"` **不给** `allow-same-origin`：游戏拿不到 localStorage / cookie / 父页 DOM。
- 叠 CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:` 把出网全堵死。
- 游戏只能玩，不能看也不能说——会话数据摸不着。
- 结算桥 `SleepyGame.report` 走 postMessage，父页**只收登记过窗口**的消息，别的页面乱发报不上来。

## 4. 结算与下一轮接话

- `htmlGameResult:<chatId>` 是按会话 id 拼的**动态单值键**（同 `charRel:<sbId>` 口径），latest-wins。
- `noteGameResult` 幂等：同一局（`msgId+score+text` 全同）重复上报**不覆盖**，换局才更新——防止重绘/重复 report 反复触发重绘。
- `gameResultPeekMsg` 读出即摘（一次性），把结算写成 system 消息垫进下一轮 prompt，并提示「自然接话，不要复述」。
- **删房清理**：`core.cleanupSandbox` 在清 `chats` 前先抓 `chatId`，把 `htmlGameResult:<chatId>` 一并 `store.remove`（同 `charRel` 动态键名单）。

## 5. 缺口①修复：重绘复用（本次收口补的）

**问题**：`renderMessages` 每次 `msgWrap.innerHTML = ''` 整块重建所有气泡，游戏 iframe 被销毁重建，
玩到一半来新消息/切皮肤/滚到顶都会让游戏从头来。

**修法**：`htmlGameCard(msg, chatId)` 按 `msg.id` 缓存同一节点（`gameCardCache = new Map()`）。
`innerHTML=''` 只是把节点摘下来，同对象重新 `appendChild` 回去**不会重载 iframe**
（browsing context 保住），游戏状态连续。`renderMessages` 末尾 `gameCardCache.forEach` prune 掉
已不在当前会话的 html 消息（删消息/换房自动释放，防跨会话串台或内存泄漏）。

全屏是**重开新 iframe**（同 srcdoc，明 Restart）——小游戏丢一局进度不心疼，按设计不变。

## 6. 测试覆盖（scripts/smoke.js）

- **抽取**：多行/大小写都认、一次只收 1 块、没闭合不收、超长截断标记、无标签不动正文——七处全对。
- **结算**：同局重复上报不覆盖、换局才更新、peek 读出即摘——幂等 + 一次性摘除都对。
- **删房清幽灵键**：拆岛时 `htmlGameResult:<chatId>` 跟着走、不误伤别岛——断言钉死。
- **静态护栏**：沙箱不给 same-origin、CSP default-src none、桥只认登记窗口、卡注册进引擎、
  **重绘复用**（`gameCardCache.get` 必须在建新节点之前、renderMessages 有 prune）——十处全在。
  四条均做过负向注入（改坏即红），非空转。

## 7. 验收状态

- `node scripts/check.js` 全绿（语法/加载/CSS 结构）。
- `node scripts/smoke.js` 全绿（83 脚本加载 + 核心 API 走查，含上述小游戏四组）。
- **待办**：真机浏览器截图验收（①卡片渲染+iframe 可玩；②结算落库+下一轮上下文；③全屏浮层；
  ④实证人「重绘不打断游戏进度」）。云浏览器额度中断，暂用静态护栏 + 代码审查 + 标准 DOM 语义替代，
  额度恢复后补 `agent-browser` 实拍。

## 8. 开放项 / 后续可选

- 群聊暂未接（群 AI 只推 groupRound 卡）——如需 char 在群里发小游戏，要扩 prompt-engine 群卡 + 群管线。
- 游戏跨设备同步当前未做（只落最终结算，不落进行中状态）；重绘复用已解决「同设备同会话内连续」。
