# Sleepy · TTS v1 落地定位与施工单（回到源码后的第一份）

> 输入：《Fish Audio TTS v1 接入与语音导演契约 v1》《全局设置 TTS 服务页 Demo v2》
> 《MiniMax 与 ElevenLabs TTS 核验及适配结论 v1》
> 本文 = 只读扫描源码 + 真实网络探测之后的**定位结果**，不是许愿清单。
> 扫描日期 2026-09-22，基线 commit `91f59bf`（v108）。

---

## 一、三份材料里我认下的红线（施工时不许破）

1. **三层文本边界**：`originalText`（聊天原文，禁止标签）/ `SpeechPlan`（服务商无关）/
   `synthesisText`（临时，只进 TTS 请求）。`synthesisText` 禁止回写气泡、搜索、记忆、导出、上下文。
2. **SpeechPlan 是唯一对外形状**：导演**只输出结构化计划**，绝不让模型直接吐 `[xxx]` 控制串；
   服务商标签由 Adapter 从**白名单映射**产生，标签数受上限。
3. **能力落在「具体模型」而不是服务商**（MiniMax 那份的硬要求）：
   `TtsModelCapabilities`，UI 允许了的功能必须真被当前模型支持。
4. **没实现就不许显示可用**：MiniMax / ElevenLabs 在 Adapter + 真实连接验证之前一律「计划支持」。
5. **试听/测试连接不得伪造成功**（Demo v1 的定时器假成功是反面教材）。
6. 失败**不影响原消息**：语音挂了，文字照常发、照常显示。

---

## 二、源码定位结果（精确到文件行）

### 已经有的落点

| 位置 | 现状 | 结论 |
| --- | --- | --- |
| `page-settings.js:195` | `row({ label: '语音 TTS', hint: '2.15 让角色把回复读出来' })` —— **没有 onClick 的死行** | TTS 服务页入口就在这儿，接上即可 |
| `page-settings.js:166-176` | 一级页现在的分组：对话（主 API / 副 API） | TTS 应与主/副 API **同级**（与注释里用户原话一致） |
| `page-settings.js:181-200` | 「其他能力」组：语音 TTS（死）/ 向量 / 总结 / 生图 / 天气搜索 WebDAV | 向量、总结已是活行（`settings-singleapi`），照它们的形状接 |
| `page-singleapi.js:1-27, 461-468` | 单份接口的完整范式：`cfgOf/saveCfg/clearCfg/testConn` + `settings-*` 页 + badge | **TTS 连接配置照这一份抄**（但要多连接、四档状态） |
| `page-imggen.js:1-13` | 接口 + 拉模型小钮 + 「试一张」折叠 + 可复制报错 | 「测试语音生成」照它；报错文案同样要求可复制、无自家链接 |
| `page-char-appearance.js:1-15` | `charAppearance = { global, byChar }`，解析顺序 角色 > 全局 > 出厂 | **角色语音配置直接用同一个形状**（正好是契约的 `global/override`） |
| `page-chat-settings.js:1-20, 778, 923` | 对话设置页：分组 + 「他离屏幕后的生活」「这篇对话用哪个模型」 | 角色语音的第二入口挂这儿（「TA 怎么说话」） |
| `page-chat.js:1821+（长按菜单）` | `ui.anchorPopover` 菜单：复制 / 编辑 / 引用 / 收藏 / 重答 | **「朗读」加在这里**（手动朗读的天然位置） |
| `media.js:107 put(blob,{kind})` / `:151 url(id)` / `:190+ usage()` | IndexedDB 图库，带 `kind` 索引与体积统计 | MP3 走 `kind:'audio'`；`url()` 给 objectURL 播放 |
| `api.js:165 requestOnce(cand, messages, ov)` / `:510-526` 出口 | 一次性非流式 JSON 调用 + `describeError` 归一化 | 语音导演复用 `requestOnce`，**不新增第二条调用路径** |
| `core.js:246-261` | 拆岛要清的 `scoped` 键名单（chats / memories / calEvents…） | **新键必须登记**，否则拆岛留幽灵数据 |
| `store.js:387-419` | `exportAll()` 把**所有** `sleepy.v1.*` 键写进备份 | 见下面第三节第 2 条冲突 |

### 还没有的（本批要新建）

- `tts.js`（新）：类型/默认值/白名单映射/`buildSynthesisText`/`speechPlanOf` 纯函数 + `Sleepy.tts` 出口
- `page-tts.js`（新）：`settings-tts`（服务列表 + 默认生成设置 + 帮助）、`settings-tts-provider`（连接详情）
- `char-voice` 页（新，可并入 `page-tts.js`）：角色语音设置，单一 `voiceState`
- 聊天气泡的「语音条」形态（`page-chat.js` + `style.css`）

---

## 三、真实探测结论（不是猜，是刚跑出来的）

### 1. Fish Audio 在**当前网络**根本连不上 —— 这直接决定首版顺序

| 目标 | 结果 |
| --- | --- |
| `api.fish.audio` 本机解析 | `157.240.7.8`（Meta 的网段），**`face:b00c` 的 IPv6** —— 污染特征 |
| `api.fish.audio` AliDNS DoH | `192.133.77.191`，**TTL=1**（污染特征） |
| `api.fish.audio` 两个 IP 直连 | 全部超时（curl `000`） |
| `fish.audio` 主站（真实 IP `39.109.122.128`） | **1 秒内 TLS 被重置**（curl exit 35） |
| `api.minimax.cn` | ✅ 通（2.1s） |
| `api.elevenlabs.io` | ✅ 通（3.0s） |

### 2. CORS 实测：浏览器直连这条路，**MiniMax / ElevenLabs 成立**

```
OPTIONS https://api.minimax.cn/v1/t2a_v2   Origin: https://sleepy-u17.pages.dev
→ 200，Access-Control-Allow-Origin: https://sleepy-u17.pages.dev（回显）
   并 Expose-Headers: *，Authorization、X-Request-From-Mark（trace 可读）

OPTIONS https://api.elevenlabs.io/v1/text-to-speech/{id}
→ 200，access-control-allow-origin: *（allow-headers: *）
```

Fish 无法验证（连不上）。

### 3. 因此，契约 §4.1 的两条安全要求**在本项目必须改写**

Sleepy 是**零依赖静态站**（`file://` + Cloudflare Pages，`serve.js` 只是本地开发服务器），
**没有服务端**：

- 「Web 优先由服务端代发 TTS 请求」→ **做不到**。只能浏览器直连，或让用户填**自建中转地址**
  （契约里 `endpoint` 字段与 Demo 的「接口地址」正好是这个口子，要保留并解释清楚）。
- 「API Key 明文不得进入普通前端持久化」→ 与现状不一致：主 API 的 Key 现在就明文存在
  `localStorage`（`sleepy.v1.mainApi*.apiKey`），而且 `exportAll()` 会把它写进备份包。
  所以只能收敛成：**Key 与主 API 同等对待（同一种存放方式、同一种导出策略），
  但绝不进入角色数据、聊天内容、日志**；日志只记后四位之类的脱敏标识。
  ⚠️ 如果单独把 TTS Key 排除在备份外，用户换设备后语音会**静默失效** —— 要脱敏就一起脱敏，
  别只特殊化 TTS。这条需要拍板（见第五节）。

---

## 四、四批施工单（按契约 §12 顺序，每批都能独立验收）

### 批 1 · 基础设施（不依赖任何网络，当天可验）

1. 新建 `tts.js`：`SleepyEmotion` / `SleepyPerformanceTag` / `SpeechPlan` /
   `GlobalTtsSettings` / `CharacterVoiceSettings` / `TtsModelCapabilities` /
   `TtsErrorCode`（按契约原文，一个不改名）。
2. `DEFAULT_*` 出厂值：模型 `s2.1-pro-free`、输出 `mp3/44100/128/normal/normalize`、
   频率 `requested`、`maxPerTurn:1`、`cooldownTurns:2`、`maxSeconds:30`、`pace:1`、
   `emotionIntensity:50`、`restraint:70`、`autoplay:'global'`、`keepTranscript:true`、
   `allowedEmotions` = 全 11 项、`allowedPerformanceTags` = 全 7 项。
3. 纯函数（只有这几个，UI 不许自己拼标签）：
   - `buildSynthesisText(originalText, plan)`：白名单映射 + 强度三档（`slightly / 空 / very`）
     + 降级规则（`restraint>=0.7` 禁 shouting；`>=0.8` 先减标签；短句不加 `very`）
     + 上限（最多一个主情绪 + 两个表演标签）+ 无法映射回退无标签。
   - `normalizePlan(plan, voiceCfg)`：过滤掉 `allowedEmotions/Tags` 之外的东西、
     越界钳位、`shouldGenerate:false` 时直接短路。
   - `capabilitiesOf(provider, model)`：模型级能力表（MiniMax 2.8 才有括号语气词、
     ElevenLabs v3 才有 audio tags、各家字符上限）。
4. `scripts/smoke.js` 加断言：白名单外标签进不来、原文本不被改、空文本被拒、
   高克制不吼叫、禁用哭腔后难过文本无 `[sobbing]`、能力表对不上时 UI 拿不到该开关。
5. `store.js` 的键登记 + `core.js:246` 的 `scoped` 名单加 `ttsSettings` / `charVoice`
   （音频 blob 在 IndexedDB，按 chatId 引用，删对话时一起清）。

### 批 2 · 全局设置页（照 Demo v2，含契约 §8 的 10 条修正）

1. `page-settings.js:195` 那行接上 `ctx.open('settings-tts')`；把它从「其他能力」
   挪到与主/副 API 同级（用户原话：「直接就是：主 api、副 api、tts…」）。
2. 新增 `settings-tts`：语音服务列表（Fish=可点 / MiniMax、ElevenLabs=「计划支持」灰行）
   + 默认生成设置（默认服务 / 默认模型）+ 帮助两行。
3. 新增 `settings-tts-provider`（连接详情）：连接名称 / API Key（密码框 + 显示切换）/
   接口地址 / 测试连接 / 保存连接 / 连接结果条 / 测试语音生成 / 打开控制台 /
   配置指南 / 替换 Key（文案照 §8.7）/ 删除连接（照 §8.8：**不无条件回退 Fish**）。
4. 状态四档 `unconfigured / untested / connected / error`，初始一律 `unconfigured`，
   默认 Key 为空，**测试连接走真实请求**（未配置时直接拒绝，不许假装成功）。

### 批 3 · 角色语音（单一状态源）

1. 新页 `char-voice`：数据 `charVoice = { global?, byChar: { [charId]: … } }`
   （照 `charAppearance`）。**所有**控件读写同一个 `voiceState` 对象，
   打开页面由它完整回填；禁止 DOM 与 JS 各记一份。
2. 控件：启用开关 / 跟随全局·覆盖（连接、模型）/ 音色 ID（非空校验）/
   频率 6 档 / 单轮上限 / 冷却轮次 / 最长语音（**说明是 Sleepy 侧筛选，不是服务商参数**）/
   语速 / 情绪幅度 / 克制度 / 情绪自动 / 自然停顿 / 允许情绪多选 / 允许表演标签多选 /
   角色表达方向（自由文本）/ 自动播放策略 / 保留文字稿 / 手动朗读。
3. 入口：角色骨架页（`contact-edit` 的「锁脸与红线」旁加一组）+ 聊天设置页一行。
4. 试听链路真实呈现：检查连接 → 生成 SpeechPlan → Adapter 组装 → 请求 → 播放 / 明确错误。

### 批 4 · 播放与聊天接线

1. `media.js`：MP3 进 `kind:'audio'`；相册/体积统计要能区分出音频
   （`page-gallery.js` 现在按 kind 画徽标，别让音频变成坏图）。
2. 聊天气泡加「语音条」形态（播放/暂停 + 时长 + 失败可重试）；
   `page-chat.js:1821` 的长按菜单加「朗读」。
3. 自动播放：受浏览器/系统媒体策略限制，失败回退到「点一下播放」（`AUTOPLAY_BLOCKED`）。
4. 失败回退验收：TTS 挂了只影响这一条语音，不影响消息本身与列表。

---

## 五、要你拍板的三件事

1. **首版先接谁的真实链路？**（Fish 在当前网络连不上，见第三节）
2. **Key 与请求路径怎么定？**（是否允许直连 + 本地存；是否保留自建中转地址）
3. **首版范围**：只做「设置 + 试听 + 手动朗读」，还是把「主动语音（频率/冷却）」一起做进来。

拍完我就按批 1 开工 —— 那一批不依赖网络，能立刻用 `pnpm smoke` 锁住。


---

## 六、施工进度（2026-09-22 当天，v109）

### 用户拍板的三件（这一节的依据）
1. **首版服务商**：由我定 —— 决定 **Fish Audio + MiniMax 两个 Adapter 都实现**，
   ElevenLabs 保持「计划支持」（能力表已登记，没有 Adapter 不给入口）。
   **⚠️ 这条当晚就变了**：用户说「我目前只注册了 fish audio，所以没关系，你先往下做另外的 tts」，
   于是补上了 ElevenLabs Adapter（见第七节）—— 三家现在都有适配器，设置页里不再有灰行。
   理由：Fish 是契约定的首版（标签最全），但实测它的接口在部分网络下被 DNS 污染 + TLS 阻断；
   MiniMax 国内可达、CORS 实测允许浏览器直连，是**没有代理的设备上唯一能真跑通**的一条路。
   两家一起做，用户在哪台机器上都有能用的。
2. **Key 与请求路径**：**直连 + Key 本地存，和主 API 一致**（导出包也照旧带上；
   日志只记后四位；绝不进角色数据/聊天正文/记忆）。
3. **首版范围**：**含主动语音**（频率 6 档 / 单轮上限 / 冷却轮次 / 最长语音 / 自动播放策略）。

### 四批施工单的落地情况

| 批次 | 状态 | 落在哪 |
| --- | --- | --- |
| 批 1 基础设施 | ✅ 完成 | **`tts.js`**（新）：契约类型 / 出厂值 / 白名单 / `speechPlanOf` 规则版 / 能力表（模型级）/ Fish + MiniMax 两个 Adapter / 错误归一化 / 可注入 transport（按调用优先，且真实 fetch 兜底） |
| 批 1 冒烟 | ✅ 8 条 | `scripts/smoke.js`「语音 TTS（契约红线 / 语音导演）」：白名单、短句不堆标签、原文不被改、不确定回退平静、禁用哭腔不出 `[sobbing]`、高克制不加 `very`、频率/冷却/长度三道闸、能力落到模型、连接四档状态、删服务不无条件回退、401/超时归一化、角色语音单一状态源 |
| 批 2 全局设置 | ✅ 完成 | **`page-tts.js`**（新）：`settings-tts`（总开关 / 服务列表 / 默认模型 / 自动播放 / 帮助）+ `settings-tts-provider`（连接名称 / API Key / 接口地址 / 测试用音色 / 测试连接 / 测试语音生成 / 控制台 / 高级诊断 / 换连接 / 再建一条 / 删除） |
| 批 2 入口 | ✅ 完成 | `page-settings.js`：原来那行**没绑 onClick 的死行**「语音 TTS」接上了，并从「其他能力」挪到与主/副 API 同级的新分组「语音」；badge 跟着 `tts.summary()` 走 |
| 批 3 角色语音 | ✅ 完成 | `char-voice`（在 `page-tts.js` 里）：服务/模型（跟随默认 or 覆盖）/ 音色 / 频率 / 单轮上限 / 冷却 / 最长语音 / 语速 / 情绪幅度 / 克制度 / 情绪自动 / 自然停顿 / 允许情绪 / 允许表演 / 表达方向 / 自动播放 / 保留文字稿 / 手动朗读 / 试听 + 诊断。**未单独设置时是只读的**，点「单独设置」才写角色层（避免「碰一下就再也不跟默认」） |
| 批 3 入口 | ✅ 完成 | 聊天设置页「个性化 → 语音」（原来也是死行）+ 角色骨架页新增「声音 → 角色语音」 |
| 批 4 播放 | ✅ 完成 | `page-chat.js`：气泡语音条（播放/暂停/播完复位）、长按菜单加「朗读 / 重读」、`media` 存 `kind:'audio'`、删消息时连带清音频、`keepTranscript=false` 时只留语音条 |
| 批 4 自动语音 | ⚠️ 已接线、待真机触发验收 | 接在角色回复落地点（和总结/查手机/主动消息同一位置），冷却判据**从消息本身数**（不另存指针） |

### 验证

- `pnpm check` + `pnpm smoke` 全绿（注册页面 76 个，含三个新页面）。
- 真机 `D:/tmp/verify-tts.js`：**22 项断言全过**（全程注入 transport，不打真网络）——
  设置页活行与状态、ElevenLabs 标「计划支持」、测试连接成功→已连接 / 401→连接异常、
  角色语音回填与试听（诊断里能看到 `[calm]` 这类**只给服务商看的临时文本**）、
  长按「朗读」→ 音频进图库（`kind:audio`）→ 语音条 → 播放/暂停/重播/播完复位、
  关掉「长按给朗读」后菜单里就没有它了。
- **还没验的一段**：真实服务商的真机链路（要有 Key 的人来跑）——契约 §11 明确
  「不得仅凭 Demo 假连接通过验收」，所以这一段必须由用户填真实 Key 后在设备上跑一次：
  设置 → 语音 TTS → 连一家 → 填音色 ID → 测试连接 → 角色语音填同一个音色 → 试听。

### 施工中发现并修掉的几个坑（都值得记住）

1. **`chat` 不是 page-chat 里的变量**：语音条那几个 helper 一开始写了裸 `chat`，
   `'use strict'` 下整页 `ReferenceError`，**整个对话白屏**。现在统一走 `curCharId()`。
   （`smoke` 的全页渲染冒烟漏了它：`chat-detail` 没有 chatId 时 render 会提前返回。）
2. **测试完别整页重画**：连接详情页原来在测试回调里 `build()`，把刚写出来的
   「连接成功」一起擦掉了（结果是挂在旧 DOM 上的）。现在只刷状态胶囊。
3. **`neutral` 不该带强度词**：平静是「没有情绪信号」，拼出 `[slightly calm]` 是自相矛盾 →
   改成 `[calm]`；顺带补上「克制度 ≥ 0.8 时连 `very` 都不给」。
4. **音频 mime 跟着响应走**：写死 `audio/mpeg` 的话，中转/自建接口回 wav/ogg 时标签就是错的。
5. 真机脚本的坑：假音频只有 0.4 秒，**隔一会儿再读播放态会读到「播完了自动复位」**——
   每一步都要在同一个 `evaluate` 里紧接着读（顺手把「播完复位」也验了）。


---

## 七、ElevenLabs Adapter（2026-09-22 晚，v110）

用户拍板：「我目前只注册了 fish audio，所以没关系」+「你先往下做另外的 tts」——
即按 MiniMax 那份 §7 的顺序继续往下推第 6 步（实现 ElevenLabs Adapter），
首版不纠结「本机连不上 Fish」这件事。

### 依据不是文档转述，是官方规格本身

拉的是 **官方 OpenAPI**（`https://api.elevenlabs.io/openapi.json`，2.2MB）与
v3 提示词指南（`/docs/overview/capabilities/text-to-speech/best-practices.md`）。
MiniMax 那份材料 §8 明说「不能整份原样变成生产契约」，所以这次只吸收**确认过**的：

| 事实 | 来源 | 落到代码哪 |
| --- | --- | --- |
| `POST /v1/text-to-speech/{voice_id}`，音色在**路径**里 | OpenAPI path | `elUrl()` |
| 凭据头是 `xi-api-key`（**不是** Authorization） | OpenAPI parameter | `buildRequest` 的 headers |
| `voice_settings` = stability / similarity_boost / style / use_speaker_boost / speed | OpenAPI `VoiceSettingsResponseModel` | `buildElevenVoiceSettings()` |
| `speed` 取值 **0.7–1.2** | OpenAPI（maximum/minimum） | 钳位后再发 |
| `speed` 只对 2.5 系列生效 | 官方 voice_settings 说明 | `caps.speed`（只有 Flash 为 true） |
| `apply_text_normalization` 是 `auto/on/off` 枚举；v2/v3 的规范化一直开着 | OpenAPI 枚举 + 文档 | 只对 Flash 发 `'on'` |
| 输出格式走查询参数 `output_format=mp3_44100_128` | OpenAPI parameter | `elUrl()` |
| 200 直接回 `audio/mpeg` 二进制 | OpenAPI responses | `expect:'audio'` → 复用现成二进制路 |
| 401 错误体是 `{detail:{message,...}}`；422 是 `{detail:[{msg,...}]}` | 实测 + OpenAPI | `errorMessageOf()` |
| v3 的 Audio Tags 是**自然语言方向**，官方给的是分类示例表 | v3 提示词指南 | `EL_EMOTION` / `EL_TAG` |

### 三条克制下来的决定（都是「宁可少做，不许猜」）

1. **只映射官方文档里出现过的标签**。v3 的标签表只列了
   `[laughs] [whispers] [sighs] [exhales] [sarcastic] [curious] [excited] [crying] [mischievously]…`，
   所以我们把 `laugh→[laughs] / sigh→[sighs] / whisper→[whispers] / crying→[crying] / breathy→[exhales]`，
   情绪里映射 `happy/tender(→reassuring)/concerned(→sympathetic)/surprised/annoyed`。
   **`sad`、`angry`、`tired`、`disappointed`、`cold`、`soft`、`low` 一律不加标签** ——
   官方表里没有对应词，与其拼一个可能被念出来的词，不如按音色本身的底子读。
   等真实试听过、确认安全再补（这是契约「无法映射回退无标签」的应用）。
2. **按模型发字段**。`speed` 只随 Flash 发、`apply_text_normalization` 只随 Flash 发、
   Audio Tags 只随 v3 发 —— UI 允许了什么，就必须真被当前模型支持（MiniMax 那份 §4）。
3. **能力表也跟着扩**：`capabilitiesOf` 新增 `speed` / `textNormalization` 两个布尔，
   继续挂在模型上，不挂在服务商上。

### 顺带修掉/补上的

- `errorMessageOf()` 统一解析各家错误体（Fish 的 `message`、ElevenLabs 的 `detail.message`
  / `detail[0].msg`、解析不出来就用原文）。以前 `responseToBlob` 里只认 `message`，
  ElevenLabs 的 401 会被显示成一段原始 JSON。
- `normalizeHttpError` 补了「音色不存在 / 模型不可用 / 文本超长」的文本判据
  （ElevenLabs 报音色不存在用的是 400/422，不是 404）。
- `elUrl()` 处理**地址上本来就带查询串**的中转（`?token=xxx`）：音色要插在 `?` 之前，
  直接字符串相加会拼出 `.../tts?token=abc/<voice_id>` 这种 404 地址。
- 自建中转可以在接口地址里写 `{voice_id}` 占位，位置自己定。
- 「默认服务与模型」里换供应商时顺手把默认模型换成这家第一条（以前会存着 Fish 的档位、
  列表却是别人家的）。

### 验证（v110）

- `pnpm check` + `pnpm smoke` 全绿；冒烟新增 ElevenLabs 断言：URL/凭据头/body.model_id、
  v3 才有 Audio Tag、Flash 带 speed 且必须带 `apply_text_normalization`、
  `detail.message` 与 `detail[0].msg` 两种错误体、中转带查询串的 URL 拼装、
  以及「三家都不许再标 planned」。
- 真机 `D:/tmp/verify-tts.js`：**加到 40 项断言，全过**。新增第 6 节（ElevenLabs 适配器，
  注入假服务商：URL 形状 / xi-api-key / v3 标签 / Flash 不发标签但带语速与规范化 /
  **拿回的音频真的能解码播放** / 真实 401 错误体归一化）与第 7 节（真实网络）。
- **第 7 节是这一轮唯一「真打了网络」的一段**（无效 Key，只看连得上吗）：
  | 目标 | 结果 | 含义 |
  | --- | --- | --- |
  | `api.elevenlabs.io` | **HTTP 401 · 1.5s**，body 能完整读出 | 跨域放行 + 错误体可读 → 直连成立 |
  | `api.minimax.cn` | **HTTP 200**（`base_resp.status_code=1004`）· 0.3s | 国内可达；顺便验了「200 也可能是失败」那条 |
  | `api.fish.audio` | 9s 超时（`TimeoutError`） | 再次确认被墙，**必须**能走自建中转 |
  另外用**真网络**走了一遍 `generate()` 的 MiniMax 失败路径：
  200 + base_resp 1004 → 归一化成 `CREDENTIAL_INVALID`（providerCode 1004），
  证明「hex 那条路 + base_resp 解析 + 错误归一化」在真请求下也对。

### 还没验的（照旧，要用户来）

真实 Key 下的**成功**链路（契约 §11：不得凭假连接通过验收）。三家现在都能从设置页进去，
流程一样：连一家 → 填 Key 和音色 ID → 测试连接 → 角色语音填同一个音色 → 试听。


---

## 八、把「接口」补齐：一次探测、三家落地、六家写清原因（v111）

用户：「往下把 tts 的接口都做完」。于是先把**候选服务商全量探测一遍**（可达性 + CORS 预检），
再按结果决定「实现 / 写清为什么接不了」——不是凭感觉挑。

### 8.1 探测结果（2026-09-22 晚，本机网络 + 生产源）

| 服务商 | 可达 | CORS 预检 | 结论 |
| --- | --- | --- | --- |
| 硅基流动 `api.siliconflow.cn` | ✅ 404（正常） | ✅ `allow-origin: *` / `allow-headers: *` | **实现** |
| Azure `eastasia.tts.speech.microsoft.com` | ✅ 404（正常） | ✅ `allow-origin: *` / `allow-headers: ocp-apim-subscription-key` | **实现** |
| 阿里云 DashScope | ✅ 401 | ✅ 回显 Origin | 接口通，但**音频是临时链接**返回的，那个链接能不能跨域取回没验 → 先不开 |
| 火山引擎（豆包）`openspeech.bytedance.com` | ✅ 404 | ❌ 预检 404 | 接不了 → 中转 |
| 腾讯云 `tts.tencentcloudapi.com` | ✅ 200 | ❌ 响应无跨域头（还要 TC3 签名） | 接不了 → 中转 |
| Deepgram | ✅ 401 | ✅ 回显 Origin | 可用但音色以英文为主，本轮不做 |
| OpenAI 官方 | ❌ 连不上（`TypeError`） | — | 本机不可达 + 官方不给浏览器跨域 → 只能中转 |
| Cartesia / Google Cloud TTS | ❌ 12s 超时 | — | 不可达 |
| 讯飞 / Edge TTS | — | 只有 WebSocket | 静态前端这条「拿回二进制」的链路接不了 |

### 8.2 新落地的三家

1. **硅基流动**（`/v1/audio/speech`，OpenAI 兼容）：Bearer 鉴权，body 是
   `{model, input, voice, response_format, speed, sample_rate}`；音色要**连模型名一起写**
   （`FunAudioLLM/CosyVoice2-0.5B:alex`，官方 8 个预置音色）。
   mp3 的采样率官方只认 **32000/44100**，所以发送前钳一下。
   官方文档里**没有**情绪/标签字段 → `caps.performanceTags = false`，正文原样。
2. **Azure 语音**：**只吃 SSML**，音色写在正文里（`<voice name='zh-CN-XiaoxiaoNeural'>`），
   凭据头是 `Ocp-Apim-Subscription-Key`，输出格式走 `X-Microsoft-OutputFormat`。
   两个坑都踩了并修掉：
   - 它的输出格式**只有固定几组**（16k:32/64/128、24k:48/96/160、48k:96/192），
     拿我们的 44100/128 直接拼 `audio-44khz-...` 会被 400 —— 现在就近取一档合法组合；
   - SSML 里的 `& < >` 必须转义，否则正文里一个 `<` 就整条失败。
   为此给 transport 加了 **`rawBody`**（整段字符串原样发，不 JSON 化）。
3. **自定义 · OpenAI 兼容**：这是「其它所有家的后门」——
   自建 GPT-SoVITS / fish-speech / openedai-speech / LocalAI、或者自己搭的 one-api 中转，
   只要对方认 `/v1/audio/speech` 就能用。上面那些「接不了」的家也能先转成这个形状。
   它的模型名千奇百怪，所以给**连接**加了自由填写的「模型 ID」（`conn.model`），
   优先级：角色单独设的 → 连接上填的 → 全局默认 → 这家第一条。

**同时给 transport 补的两件**：`rawBody`（上面那条）、以及错误体解析加了
`{"error":{"message":...}}`（Azure / OpenAI 系）—— 之前只认 `message` 和 `detail.*`。

### 8.3 接不了的六家：写清原因，而不是一个灰行

设置页新增「**还不能直连的服务**」一组（`PROVIDER_PLANNED`），每一行下面写实测原因
（无跨域头 / 要 TC3 签名 / 只有 WebSocket / 音频走临时链接 / 本机不可达），
末尾一行「用『自定义 · OpenAI 兼容』接它们」直接跳过去配。
契约 §8.6 要求「没实现不许显示可用」，但「灰着不说为什么」和「写清为什么」是两件事。

### 8.4 验证（v111）

- `pnpm check` + `pnpm smoke` 全绿（76 页）。冒烟新增：硅基流动的 body/采样率、
  Azure 的 SSML 与转义与输出格式白名单、自定义那家没填地址时**直接拒绝**（不许变成「超时」）、
  `error.message` 的解析、以及「接不了的清单必须都写清原因」。
- 真机 `D:/tmp/verify-tts.js`：**加到 55 项，全过**（新增第 8 节三家组装 + 第 9 节真实网络）。
- **真实网络（生产源 + 本机，无效 Key）**：
  | 目标 | 结果 |
  | --- | --- |
  | `api.siliconflow.cn` | HTTP 401 · 0.7s，body `{"code":30014,"message":"Token is invalid."}` 读得出 |
  | Azure `eastasia` | HTTP 401 · 1.0s（响应体为空，走状态码归一化） |
  | `api.openai.com` | `TypeError`（连不上）—— 所以官方那家只能走「自定义」填中转 |
  并让**适配器自己**用真网络跑了一遍：硅基流动 / Azure 的失败都归一化成
  `CREDENTIAL_INVALID`（不是超时）。
- 还没验的照旧：**真实 Key 下的成功链路**（契约 §11）。上面三家的 body 形状全部来自
  官方文档（硅基流动「语音合成」页、Azure SSML 文档），但「真能出声」要用户填一次 Key。

### 8.5 一句话给用户

想用哪家就在设置里连哪家：**硅基流动**（国内最省事）、**Azure**（音色最多）、
**Fish / MiniMax / ElevenLabs**（原三家）；
连不上或没有账号的（火山、腾讯、讯飞、OpenAI 官方…）→ 自己搭一个中转，
用**自定义 · OpenAI 兼容**填地址即可。


---

## 九、情绪与节奏：把两个「死字段」接上（v112）

用户问「声音情绪和节奏那些做了嘛」。逐条对照契约 §5/§6 之后发现：
**情绪与节奏的骨架早就在（v109 那批），但有两个角色设置是真·死字段** ——
界面能填、存在存档里、导演根本不读：

| 字段 | 当时的状态 | 现在 |
| --- | --- | --- |
| `naturalPause` 自然停顿 | ❌ 存了没人用 | ✅ MiniMax 插 `<#0.35#>`、Azure 插 `<break time="350ms"/>` |
| `characterDirection` 角色表达方向 | ❌ 存了没人用 | ✅ 当**低权重先验**参与情绪/标签/语速 |
| Azure 的情绪 | ❌ 只发正文（没有情绪通道） | ✅ 映射到官方 `mstts:express-as` 风格 |
| Azure 的语速 | ❌ 没发（不确定语法） | ✅ `prosody rate="1.16"`（官方：0.5–2 的倍数） |

### 9.1 先盘点：情绪与节奏**原来就已经做了**的部分

- **导演**（`speechPlanOf`，纯规则版）：情绪词典命中一个就够 → 标点小幅加成 →
  强度 = 文本信号 × 用户情绪幅度 → 白名单过滤 → 高克制/短句**减标签** → 语速按情绪微调（±6%）。
- **每件角色**可配：语速 70–130、情绪幅度、克制度、情绪自动开关、允许情绪（11 项多选）、
  允许表演（7 项多选）、频率 6 档、单轮上限、冷却轮次、最长语音、自动播放、保留文字稿、手动朗读。
- **各家映射**：Fish `[emotion][tag]` + `prosody.speed`；MiniMax `voice_setting.emotion` +
  括号语气词 + `speed`；ElevenLabs v3 Audio Tags + `stability/style`（Flash 才有 `speed`）；
  硅基流动/自定义只有 `speed`（官方文档里没有情绪字段）。

### 9.2 这一轮补的三件

1. **自然停顿真的插了**（契约 §5.9：只进临时合成文本）。表驱动、受控规则：
   **只在句末**、句子够长（≥6 字）才插、整段**最多 3 处**（官方也提醒插多了不稳）。
   - MiniMax `<#0.35#>`（那份材料 §5.1 点名的映射）；
   - Azure `<break time="350ms"/>`；
   - Fish / ElevenLabs / 硅基流动 / 自定义：**一个字都不插**，并在界面上写清「这几家没有可控的停顿字段」——
     宁可不做，也不假装做了。
   - 实现细节：**先逐句转义、再拼停顿标签**（整段转义会把 `<break/>` 也转义成文本）。
2. **角色表达方向真的参与**。规则版只能当**低权重先验**，做法是给它配一套**「表达习惯」词典**
   （`DIR_EMO` / `DIR_TAG`，与正文词典分开 —— 正文里的「哈哈」是当下在笑，方向里写的「爱笑」是这人的常态）：
   - 只在正文没给出情绪时参考它（正文永远优先）、命中后仍要过用户的白名单（开关优先）；
   - 表演习惯（爱叹气 → `sigh`）只在正文没给出标签时补**一个**；
   - 「慢性子 / 慢条斯理」→ 语速 −4%，「语速快 / 连珠炮」→ +4%（仍在 0.7–1.3 内）。
   - 这段自由文本**绝不进合成文本**（契约 §5.2：导演不许吐服务商字符串）。
3. **Azure 的情绪与语速**。风格表**逐字来自官方语言支持页**，只给核对过的四个中文音色建表
   （晓晓 / 云希 / 云健 / 晓伊），每个音色只映射它**真支持**的风格名：
   `happy→cheerful`、`tender→gentle`、`concerned→calm`、`sad→sad`、`annoyed→disgruntled`、
   `cold→serious`、`whisper→whispering`（角色明确要求的表演优先于情绪）……
   `styledegree` 由情绪幅度换算（官方范围 0.01–2）。表里没有的音色**一律不发**。
   语速走 `<prosody rate="1.16">`（官方：0.5–2 的倍数或 `+20%`，用倍数没有歧义）。

### 9.3 还没做的（写清楚，别当已完成）

- **模型版导演**（让模型读上下文判断情绪）**没做** —— 现在是纯规则版：靠词典 + 标点 + 用户配置。
  契约 §5 只要求「导演输出结构化 SpeechPlan、不许直接吐服务商字符串」，规则版满足；
  想要更准的判断（反讽、言外之意）得再上一层，那是独立的一件事。
- Fish / 硅基流动 / 自定义那几家的**停顿与情绪**：接口没有对应字段（或官方没确认），
  所以只有「正文 + 语速」，不硬凑。
- 真实 Key 下的**成功**链路照旧等用户（契约 §11）。

### 9.4 验证（v112）

- `pnpm check` + `pnpm smoke` 全绿。冒烟新增一整个测试块「情绪与节奏」：
  方向先验（命中/不越白名单/正文优先）、停顿三处上限与短句不插、关掉就一个都没有、
  「没有停顿字段的家一个字都不许插」、Azure 的 `express-as`/`prosody`/`break` 与**转义正确**
  （`<break/>` 不被转义、正文里的尖括号必须被转义）、`styledegree` 在官方范围内、没核对过的音色不发风格。
- 真机 `D:/tmp/verify-tts.js`：**62 项断言全过**。新增第 10 节：假服务商下走完整链路
  （MiniMax 走 json-hex、Azure 走二进制），再在**角色语音页**点「读一次」，
  验诊断里写着「停顿 开」且真发出去的正文带 `<#0.35#>`。
