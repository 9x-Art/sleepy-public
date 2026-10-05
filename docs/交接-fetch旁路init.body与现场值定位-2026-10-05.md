# fetch 旁路记 init.body + 夹具现场值丢失定位（2026-10-05）

> **本批状态：采集能力已落地并双绿；现场值丢失已定位到根因，暂未修复。**
> **零网络、零付费**：未启动 Edge、未调真实模型、未发任何请求。
> 未提交 / 未 push / 未部署。
> 未改 `prompt-engine.js` / `page-offline.js` / `api.js` / `behavior-text.js`。

---

## 一、交付物

| 文件 | SHA-256（前 32 位） | 状态 |
|---|---|---|
| `scripts/lib/f2-body-capture.js` | `8fccac8c84b125554d1aa97f6cdb38dc` | **新增** · 旁路采集模块 |
| `scripts/offline-f2-sendbody-test.js` | `f9a868d09f2ba6c3cc9be37b4bb5aac4` | **新增** · 40 条零网络测试 |
| `scripts/offline-f2-fixture-trace-test.js` | `21453fb5e9b22c14b3db8bb44e7d8066` | **新增** · 20 条逐字段追踪 |
| `scripts/offline-f2-effect-acceptance.js` | `7fdf0ced19f982d96847197dcde68cde` | 改 · 接入旁路 + 导出夹具 |
| `scripts/offline-f2-effect-fields-test.js` | `0280bb06bb503b59772b78229a78ff66` | 改 · 比对对象改为执行体 |
| `docs/取证-F2现场值丢失追踪-2026-10-05.json` | `b2dbc966512080bc8ef5d080d9340e90` | **新增** · 逐字段取证 |

### 测试结果（退出码全 0）

| 测试 | 通过 / 失败 |
|---|---|
| `offline-f2-sendbody-test.js` | **40 / 0** |
| `offline-f2-fixture-trace-test.js` | **20 / 0** |
| `offline-f2-depstop-test.js`（既有） | 36 / 0 |
| `offline-f2-edge-test.js`（既有） | 48 / 0 |
| `offline-f2-schedule-test.js`（既有） | 50 / 0 |
| `offline-f2-effect-fields-test.js`（既有） | 117 / 0 |
| `pnpm check` / `pnpm smoke` | 全绿 / 全绿 |

---

## 二、fetch 旁路记「发送瞬间 init.body」

### 逐条对照你的要求

| # | 要求 | 落法 |
|---|---|---|
| ① | 记录在调用 `origFetch` **之前**，保存原始 body 字符串 | `installFetchBypass` 在**同步段**先采 `init.body` 再调 `origFetch`。测试用「`origFetch` 执行那一刻回读 `__SEND`」的时序桩证明此刻已有 1 条 |
| ② | 优先 JSON，只存 `model/messages/stream/max_tokens/temperature` | `KEEP_FIELDS` 白名单。`tools/top_p` 等**不提升**为顶层字段（但 `bodyTopKeys` 记它存在） |
| ③ | `messages` 保留 role 与 content | 每条 `{role, content}`，content 是**可读原文**。测试断言 `isNaN(Number(content))` —— 防止退化成长度/哈希 |
| ④ | API key / Authorization / 真实凭据删掉或脱敏 | 两条腿：① 键名正则（`api_key`/`authorization`/`token`/…）命中就整值替换；② **取值形状**（`sk-…` / `Bearer …` / JWT）即使键名无辜也打掉。脱敏只动凭据那几段，周边文字逐字保留，并记 `脱敏处数` |
| ⑤ | 记 body SHA-256，明确是发送瞬间请求体的哈希 | `bodySHA256` 对**原始串**算（在脱敏**之前**），字段旁带 `bodySHA256含义` 写明「这是发送瞬间请求体（init.body 原始字符串）的 SHA-256，不是任何装配快照的哈希」 |
| ⑥ | 响应侧 `finish_reason`/`usage`/`reasoning_content` 采集**全部保留** | 原样搬进旁路模块，一条没删。测试逐字段断言（含 `has_reasoning`/`reasoning_len`/`msgKeys`） |
| ⑦ | 请求体采集失败不能静默伪造，记 `bodyCaptureError` | 6 种失败形态各自留痕，`messages` 一律 **null**（不是 `[]`）。附负向对照 |
| ⑧ | 测试断言发送记录的 messages 与 `init.body` 一致 | §4 逐条一致 + §8 用**真实装配产物**当 messages 走完整链（14 条）逐条一致 |
| ⑨ | 只做零网络单元/桩测试 | 全部纯 Node + vm 沙箱 + 假 fetch。**未启动 Edge、未调模型** |
| ⑩ | 不改 prompt-engine / page-offline / api / behavior-text | 测试里用 mtime 断言（见 §六「基线口径」） |

### 为什么单独抽一个模块

采集逻辑要同时在两个环境跑：Node 侧单测 `require` 它、页内 `evaluate` 里跑它。
**写两遍必然漂移，而漂移的方向恰好是「测的和发的不是同一个东西」。**
所以只写一份，页内用 `(0, eval)(源码文本)` 注入。

### 为什么 SHA-256 要手写

- 页内**没有 `require`**；
- `crypto.subtle.digest` 是**异步**的，而采集必须**同步**完成（在 `origFetch` 之前）。

所以实现了纯 JS SHA-256，并用 `node:crypto` **对拍 14 例**（空串 / 55·56·63·64·65 块边界 / 中文 / emoji / 落单代理项），外加**阳性对照**（改一个字节哈希必须变，防「恒等函数」假绿）。

⚠️ 手写当场就被抓到一个 bug：`t1`/`t2` 用了没声明 —— strict mode 下会抛，页内同样会炸。对拍立刻报出来。

### 时序

```
fetch(input, init)
  ├─ ① 同步：captureRequestBody(input, init)  → __SEND.push   ← 发送瞬间
  └─ ② origFetch(...)
        └─ .then → r.clone().text() → 解析响应 → __HTTP.push   ← 响应侧（保留）
```

`__HTTP` 每条记录上挂 `发送瞬间`，两侧可对齐。**响应 JSON 坏掉时，请求侧记录仍在** —— 不能连坐丢证据。

---

## 三、夹具现场值丢失：逐字段定位结果

**追踪链**（每步都从 store 回读，不用内存局部变量）：

```
FIXTURE.scene → SETUP 写入 → offlineStore → assembleOffline → 请求体 messages
```

### 判定表

| 字段 | 夹具预期 | ② SETUP 后（store 直读） | ④ 装配场景段 | 首次异常 |
|---|---|---|---|---|
| `sceneName` | 雨夜的旧书店 | **未命名场景** | 「未命名场景」 | **② 被默认值覆盖** |
| `location` | 城西旧书店二楼阁楼 | **—** | 地点 — | **② 被默认值覆盖** |
| `timeOfDay` | 深夜 | **傍晚** | 时段 傍晚 | **② 被默认值覆盖** |
| `weather` | 雨 | **晴** | 天气 晴 | **② 被默认值覆盖** |
| `clockTime` | 23:40 | **16:42** | 时刻 16:42 | **② 被默认值覆盖** |

**五个字段全部在同一步失效：`SETUP` 写完那一刻。**
`createSession` 的默认值（从生产源码正则读出，不手抄）：
`{sceneName:'未命名场景', timeOfDay:'傍晚', weather:'晴', location:'—', clockTime:'16:42'}`。

### 根因（机制级，有对照实验）

`Sleepy.offlineStore.findSession` 内部走 `allSessions() → store.get`，
而 **`store.get` 返回深拷贝** → `findSession` 拿到的是**孤儿副本**。
SETUP 对它做 `s2.sceneName = …` / `s2.env = …` 的直接赋值**静默丢失**。

对照实验（三条，各自独立沙箱）：

1. `store.get` 拿到的数组改字段 → 再读**没变** ⇒ 确认深拷贝；
2. `findSession` 后直接赋值 → 再 `findSession` **读不到** ⇒ 确认孤儿副本；
3. 走 `offlineStore.updateEnv`（→ `mutateSession` → `saveAll`）→ **能落库**。

⇒ 差别在**写入路径**，不在数据。

**源码佐证**：SETUP 里有 `var upd = Sleepy.offlineStore.updateEnv;` ——
**取了引用，但 `updateEnv` 的调用次数 = 0**。真正生效的写入是对孤儿副本的直接赋值。
这就是「以为写进去了、其实没写」的典型形态。

---

## 四、⚠️ 守住的那条边界

> 不能因为响应后快照显示「傍晚／晴」，就补写成模型当时收到的内容。

本轮的表述纪律：

- 报告只写「**夹具预期**」与「**链路各步实际**」，**不含**任何「模型当时收到了什么」的结论；
- 取证 JSON 里有护栏测试：文件里出现「模型收到」「已送达模型」「模型当时看到」等字样即判红；
- 明确写下：「这解释了为什么装配快照里是傍晚/晴，**不等于**已证明模型当时收到的是傍晚/晴」。

**下一轮有了 `init.body`，才能把三层真正对齐**：

| 层 | 来源 | 时序 | 本轮状态 |
|---|---|---|---|
| ① 夹具预期 | `FIXTURE.scene` | — | ✅ 已有 |
| ② **发送瞬间请求体** | fetch 旁路 `init.body` | origFetch **之前** | ✅ 能力就绪，**未取真实样本** |
| ③ 响应后装配快照 | `OUTBOUND()` 重跑装配 | 响应**之后** | ✅ 已有 |

已在轮记录里加 `三层对齐` 字段，显式登记两个哈希的**口径差**：
`init.body` 整段 JSON 串 vs `role\ncontent` 按 `---` 拼接 —— **不相等是正常的**，
不能用它判断「模型没收到场景」，那种判断必须看 messages 原文逐字段比。

---

## 五、本批**未**做

- ❌ **未修复**现场值丢失（按要求只定位）
- ❌ 未取真实 `init.body` 样本（不启动 Edge、不发请求）
- ❌ 未给旧样本补造发送证据
- ❌ 未改 `prompt-engine.js` / `page-offline.js` / `api.js` / `behavior-text.js`
- ❌ 未提交 / 未 push / 未部署

---

## 六、两个测试自身的坑（都当场抓到了）

### 1. §5 一致性断言：代码搬走就恒红

归因代码从验收脚本搬进旁路模块后，`offline-f2-effect-fields-test.js` 的
「EXTRACT_SRC 逐行在验收脚本中存在」**恒红 11 条**。

**那条红不代表归因逻辑坏了**，是判据指向了旧位置。

修法不是放宽成「任意文件都算」，而是：
- 比对对象改成**真正执行归因的那份源码**（`f2-body-capture.js`）；
- **额外**断言验收脚本确实 `F2BodyCapture.installFetchBypass(...)`、确实读同一个模块文件 ——
  否则「库里有一份对的代码、脚本压根没调它」也能全绿；
- 补**两个阳性对照**：不存在的片段查不到；只存在于验收脚本的行在执行体里也查不到。

顺带两处对齐：
- `Date.now()` → `win.Date.now()`（页内 `evaluate` 没有宿主 `Date`）；
- `rec.parseError = String(e && e.message)` → 加 `|| e`
  （旧写法在 `message` 为空串时记成 `''`，看起来像「没有错误」）。

### 2. 边界断言拿 HEAD 当基线 → 把历史改动算成本轮的

「这四个生产文件相对 HEAD 无 diff」这条断言报红，报出
`page-offline.js` / `prompt-engine.js` 有改动。

查证：`git diff --numstat` 显示 +1216 行，但两文件 mtime 是 **2026-10-04**，
早于本轮 —— 是**此前批次遗留的未提交改动**，不是本轮造成的。

⇒ 判据换成**内容指纹 + mtime 都早于本轮开工时刻**，并在测试里**如实登记**这个基线口径，
免得下一轮看到 HEAD diff 又误判一次。

### 3. 顺带：§5 护栏差点把测试缺陷报成生产缺陷

追踪测试第一版把装配步的形状（`{场景段原文}`）和前三步（`{sceneName, env}`）混在一起判，
结果**场景段明明存在**却报成「(无场景段)」—— 差点得出「装配丢了现场值」的假结论。

实际探查：装配产出 7 条 system 段，`【当前场景】` 段**确实存在**，
只是写着默认值。修正判据（显式区分形状），并加两条护栏：
- ④ 必须真的找到场景段，否则结论作废；
- ④ 的判定只能是「一致 / 被默认值覆盖 / 被改成别的值」，**不许报「缺失」** ——
  这两种失效的修法完全不同，判错会让下一轮改错地方。

---

## 七、下一批建议顺序

1. **修 SETUP 的写入路径**（`s2.sceneName=` / `s2.env=` → 走 `updateEnv` 或 `mutateSession`），
   或按 `createSession` 的 `form` 参数直接传。改完跑 trace 测试，五个字段应全部「一致」。
   ⚠️ 改的是**验收脚本的夹具**，不是生产代码 —— 生产的 `findSession` 深拷贝是**设计如此**
   （`store.get` 必须深拷贝，否则外部能改内部状态）。
2. 再跑一次真机验收（本批已具备能力）：拿**真实 `init.body`** 与装配快照逐字段对齐，
   第一次拿到「模型当时到底看到了什么」的证据。
3. P3 仍建议**暂缓** —— 现场值问题未修前跑更多轮意义有限。
