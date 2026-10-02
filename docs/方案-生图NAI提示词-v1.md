# 方案 · 生图 NAI 通道提示词草案 v1（2026-10-02，按 v2 核查卡修订）

> 状态：**草案，未接运行时代码**。NAI 通道当前行为：`buildFormalPrompt` 对
> `kind==='nai'` 返回 null（`imggen.js:416`）→ `generate` 回落 legacy
> `buildPromptForPlan`（接口自己的 positivePreset/negativePreset + 身份段 + `{p}`）。
> 本文档是将来接 NAI 正式管线时的逐档词表 + 契约记录，到时只做映射。
> 未真图验收，不冒称已验证。
>
> **修订记录（2026-10-02，按《NAI 草案核查与最小接线交接-v2》）**：
> 自然语言支持表述改为官方口径；质量词位置改为官方事实（末尾、按模型分档）；
> 「负面重必糊脸 / 官方统一推荐 Light」降级为待真图比较的假设；
> 多人结构改为官方 base + character prompts 契约，顺序连排明确标「降级、非绑定」；
> ucPreset 改为「已证实 / 未证实」边界记账（见 §五.1），不再宣称一行修复。
>
> **修订记录 2（2026-10-02 第二轮，五条确定边界）**：
> UC 选 C（维持现状，不新增清单不付费）；正式请求禁静默回落 + 拒绝后零请求断言；
> `buildFormalNaiRequest → requestNai` 字段消费全表（schema 实取，无默认不猜）；
> 层序图改质量层置尾、char prompts 独立，人数聚合补单复数与未知性别策略；
> §六 补真实行号/原文/最小 diff 与预设消费表（区分未配置与明确留空）。

---

## 一、NAI（Diffusion V3 / V4 / V4.5）特性依据

1. **产品策略：tags 为主、短自然语言补互动**。官方文档确认 V4/V4.5 均支持自然语言
   （120 字符的建议是**画面内文字渲染**的场景，不是整体提示词上限）。
   我们仍选 tag 化，是因为 General 定稿那几大段英文底座是摄影向长句、
   与 NAI 的 Danbooru 训练分布不匹配——这是**我们的策略选择**，不是模型硬限制。
2. **质量/美学 tag 的官方事实**：官方 Quality Tags 开关把质量词追加在提示词**末尾**
   （V3～V5；仅 V1/V2 在开头），且各模型档位组合不同——如 V4.5 Full 是
   `, location, very aesthetic, masterpiece, no text`、V4 Full 是
   `, no text, best quality, very aesthetic, absurdres`、V3 是
   `, best quality, amazing quality, very aesthetic, absurdres`。
   我们现用的 `best quality, amazing quality, very aesthetic, absurdres` 是**自选候选**
   （与 V3 档相同），**不是官方统一默认**；接正式管线时应按 `api.model` 分档取用。
3. **人数 tag 原生且最强**：`1girl` / `1boy` / `1other` / `2girls` / `3girls`…。
   ⚠️ 官方多人契约下人数 tag 只进 **base prompt**，character prompt 里写
   **不带数字**的 `girl` / `boy` / `other`（见 §四）。
4. **负面**：官方网页端 UC 预设（Heavy/Light/Human Focus/Furry Focus）是**文本清单**，
   在 prompt 框底部选择后组合进 UC 字段——即**客户端拼装**语义。
   「负面堆重会糊脸（4.x UCE 已内置规避）」目前是**待真图比较的假设**，
   不是已验证结论；Light 可作产品候选，不冒充官方对 API 的统一推荐（API 侧见 §五.1）。
5. **强调语法**：数值强调 V4+（`2::tag::`）；负值强调 V4.5+（`-1::tag::`）。
   官方发布文提到高权重测试通过，**不构成我们默认给身份加权或宣称锁脸稳定的依据**；
   如要用，逐处显式写、真图验收后再说。
6. `no text` 是正向 tag（官方用于规避画面内多余文字/标志）。
7. **多人契约（V4+，官方文档）**：`base prompt`（场景/风格/总人数 tag）+ 每人一个
   `character prompt`（`girl`/`boy`/`other` + 该主体外貌，**不放人数**）；
   网页另有 `|` 竖线语法（与 character prompt 框互斥）与 `source#` / `target#` /
   `mutual#` 动作前缀（V4+）。**竖线语法是网页层行为，未经 API 契约核实，
   不得原样搬到 input**；API 的等价结构是 `v4_prompt.caption.char_captions`
   （字段形状见 `image.V4ConditionInput`，接线前需按 doc.json 契约核实）。
   V3 不支持以上任何 V4 专属结构。

## 二、层序映射（与 buildFormalPrompt §七对齐，v2 卡第二轮修订）

```
base prompt（一条字符串；V4 档经 input 与 v4_prompt.caption.base_caption 同值送达，V3 只发 input）：
[人数聚合 tag] + [场景/镜头 tag] + [描述] + [视觉层] + [extras] + [质量层（按模型分档，置于 base 末尾）]

character prompts（每人独立一格、独立输出，不并入 base；V4+ 已接 char_captions 后生效）：
[`girl`/`boy`/`other`（不带数字，未知性别主体不写性别词）+ 该主体锁脸 tag]

NAI negative = [质量负面] + [结构负面（按档）]
             —— 本轮选 C：不新增官方 UC 清单、不混接口负面预设（见 §五.4）
```

身份块继续复用 `subjectForChar/subjectForUser → identitySegmentFor` 产出的锁脸 tag
——但**编译时消费的是已校验的主体结构（normalizePlan 后的 subjects），
不从 General 最终字符串反解析人物**；`identitySegmentFor` 里的 `1boy/1girl`
不原样反复塞回多人 base。锁脸三件本就是 tag 风格，与 NAI 契合；
**跨人物不去重**（两人都有 silver hair 是两份特征，同 General 口径）。

**当前未接 char_captions，多人一律标「未完成 / 降级」**：顺序连排只是降级形态，
**不冒充已实现绑定**——这一点写进 debug 标签与回显。

## 三、逐档词表（草案，待真图投票）

### 通用质量层（按模型分档，置于提示词末尾）
- 自选候选（现 BUILTIN_PRESET.nai 一致）：`best quality, amazing quality, very aesthetic, absurdres`
- 建议接线时按 `api.model` 对齐官方各档（V4.5 Full / V4 Full / V3，见 §一.2）
- `no text` 追加正向（防画面文字）

### 01 · 无人场景 / 物品
- 正向结构 + 视觉：`no humans, scenery, detailed background, soft lighting, highly detailed`
  - 摄影向风景/静物备选：正向加官方 `background dataset`——**仅支持的模型、
    且明确摄影向无人画面才注入**，不给所有场景无条件加
- 负面结构：`1girl, 1boy, human, person, face, portrait, selfie, watermark, logo, signature`

### 02 · 单人（男 / 女 / 中性）
- 结构：`solo` + `1boy` / `1girl` / `1other`
  （性别来自主体自身 gender 字段；未知性别不补女不补男，`1other` 是中性档候选、
  待定——不得把「未知性别」和「非人形态」混作同一事实）
- 镜头：selfie→`selfie, close-up`；portrait→`portrait, upper body`；full→`full body`；candid→`candid`
- 视觉层（候选，不宣称所有画面通用）：`detailed face, detailed eyes, natural skin texture, soft lighting, detailed background`
  ——明确非人身份不被这套默认审美反向覆盖：非人形态走自己的适用性判断
  （与 General 侧「形态档位字段待最小决定」同源，不偷偷实施）
- 负面结构：`extra person, duplicate person, bad anatomy, deformed face, asymmetrical eyes, watermark, signature, username, text`
- 中性/非人负面（去人体脸型三连，与 `SLEEPY_NEUTRAL_NEGATIVE_V1` 同口径）：
  `extra person, duplicate person, watermark, signature, username, text`

### 03 · 双人
- base 人数 tag 按已确认主体分类**聚合**：女 2 → `2girls`；男 2 → `2boys`；
  男 1 女 1 → `1girl, 1boy`；**不硬编码只支持男女几种组合**——聚合规则见 §四。
  未分类主体不产生人数 tag、不得省略不报（进 debug 与回显）。
- character prompt（未接 char_captions 前**整体降级**）：每人 `girl`/`boy`/`other`
  + 各自锁脸 tag；互动 tag 从描述里来（`holding hands` / `hugging` /
  `looking at another`…描述里写了才给）；V4+ 可用 `source#` / `target#` / `mutual#`
  前缀表达动作主被动（候选）。
- 视觉层：同 02 女那一行（共用一份）
- 负面结构：`multiple views, out of frame, crowd, watermark, signature, text`

### 04 · 群像（3～4 人）
- base 人数 tag 同上聚合（`3girls` / `4girls` / `1boy, 2girls`…，同性别合并、
  异性别并列；**不写 `1girl, 2girls` 这种同类别未合并的错例**）
- character prompt 按 A→B→C→D 每人一格（V4 上限 6 人，够用）
- 负面结构：同 03
- ⚠️ 多人没接 char_captions 时串脸概率显著升高，真图验收重点看

## 四、多人编译规则（正式接线的契约，非现状）

1. **编译器消费已校验的 subjects**（normalizePlan 产物），不解析 General 字符串。
2. **人数聚合**：对 subjects 按自身 gender 分类计数，**单复数显式分支**——
   - 计数 1 → `1girl` / `1boy` / `1other`；计数 ≥2 → `Ngirls` / `Nboys` / `Nothers`
     （如 `1girl + 2girls → 3girls`；`1boy + 1girl` 保持两个单数 tag 并列）；
   - **未知性别**：**不自动改成 `other`**（「未知」≠「确认非二元」≠「确认 other」）；
     该主体**不贡献人数 tag**、**不丢主体**——照常拥有自己的 character prompt
     （外貌 tag 照写、只是不写性别词）与独立描述；debug 与回显标
     `countCoverage: 'partial'`，**不宣称人数标签已覆盖全部主体**。
3. base 只放人数聚合 + 场景/镜头/视觉层；每人外貌只进自己的 character prompt，
   **不放人数**、`girl/boy/other` 不带数字。
4. 未接 char_captions 之前：多人 = 降级形态（顺序连排 + debug 标
   `multiCharacter: 'degraded'`），UI 回显明示，不称已绑定。
5. **模型分支**（schema 已实取，见 §6.2）：`nai-diffusion-3` 只发
   `input` + `negative_prompt`，**不发任何 V4 专属字段**；
   V4/V4.5（full / curated-preview）才构造 `v4_prompt` / `v4_negative_prompt`。
   只覆盖 `NAI_MODELS`（`imggen.js:264-269`）现有四个模型，不扩新版本。
6. **非人适用性单列**：明确非人但 gender 有值的路由沿用 General 侧待决项
   （形态档位字段 / plan.form 扩展），本轮**不新增全物种识别、不改 General 原稿**。

## 五、ucPreset 与请求链路：已证实 / 未证实边界

### 1. 当前链路事实（代码为准，行号为 2026-10-02 工作区实读）
- `imggen.js:1602` `requestNai`；请求 URL = `base + '/ai/generate-image'`，
  `base = String(api.baseUrl || NAI_BASE).trim()`（:1604）——**我们代码里没有适配器层**，
  直连官方 `https://image.novelai.net`，除非用户自己把 baseUrl 配成中转；
  若是中转，`ucPreset` 的消费者完全未知。
- 请求体（:1611-1625）：`input: built.positive`、
  `negative_prompt: built.negative || ''`（:1623）、`ucPreset: 0`（:1622）。
  **negative_prompt 的组装来源只有 `built.negative`——现有链路没有拼任何
  官方 UC 预设文本**，也没有 `v4_negative_prompt` 字段。
- `built.negative` 的来源：legacy 路径 = `api.negativePreset || BUILTIN_PRESET.nai.negative`
  （新建接口时从出厂预设拷贝，用户可改）；正式管线未接。

### 2. 已证实
- 官方 OpenAPI（`image.novelai.net/docs/doc.json`，`image.RequestParameters`）里
  `ucPreset` 定义**仅有 `{"type":"integer"}`，无 description、无 enum**；
  `negative_prompt` 仅 `{"type":"string"}`。**契约层面没有任何
  「服务端按 ucPreset 数字追加预设文本」的记载**，也不能据此排除。
- 官方文档的 UC 预设是**网页端**行为（prompt 框底部选择、文本清单），
  全部是现成文本——与「客户端拼装进 UC 字段」一致。
- 社区 SDK（如 7xrk/novelai-api、novelai-sdk-unofficial）都把各档 UC 文本
  **定义在客户端**并组合进 negative_prompt 后发送——旁证客户端拼装是主流实现。
- 本地拦截测试只能证明**我们发出了什么**，证明不了**远端怎么消费**。

### 3. 未证实
- 「改 `ucPreset: 1` 就会让服务端改用 Light 预设」——**没有任何契约支持**，
  官方数字枚举映射（0/1/2/3/4）只存在于社区 SDK 的**客户端映射**里，
  不构成服务端行为证据。
- 服务端是否完全忽略 `ucPreset`（透传/hint/实际生效）未知。

### 4. 本轮决策：**选 C —— 维持现状（2026-10-02 施工时精化）**
- `ucPreset` 保持 `:1622` 现值 `0`；**不新增官方 UC 清单、不做付费 A/B、
  不宣称已实现 Light**。
- **接口预设沿用现有消费契约**（修正第二版「正式 NAI 不消费」的表述——
  那会让已有 NAI 接口的自定义预设词静默失效）：正式 NAI 编译器消费
  `api.positivePreset` / `api.negativePreset`（`api.xxx || BUILTIN_PRESET.nai.xxx`，
  空串/未配置按现有契约回填出厂词，与 legacy 同款）；**预设就是质量层**，
  编译器不再另抄一份质量词，结构负面与预设负面做词条级跨层去重
  （`dedupeTerms`），同一套出厂词不会追加两遍；不覆盖存储内容。
- 已知继承项：出厂负面表里的 `old, aged up` 随预设契约进入正式 NAI 请求
  （与 legacy 同源，冲突方向已在与「年长主体」同类的场景记账，真图时观察）。
- 视觉层 builtin/custom 与接口预设**分别处理**（§6.1 消费表），
  任何路径都不覆盖已保存文本。

## 六、最小接线方案（真实路径/行号/原文/拟替换 diff；待授权施工，本轮未动运行时）

行号与原文为 2026-10-02 工作区实读（HEAD `da61f2d` + 未提交改动，本轮未改 `imggen.js`）。

### 6.1 消费表：接口预设 vs builtin/custom（空值语义）

| 来源 | 正式 general/chat（现状） | 正式 NAI（2026-10-02 实装） | legacy（现状：试一张 legacy 档 + AI 解析失败兜底） |
|---|---|---|---|
| `api.positivePreset` | 不消费 | **消费**（现有契约：`api.positivePreset \|\| BUILTIN_PRESET.nai.positive`；`{p}` 替换 core 后质量词置尾） | 消费：`:1379`/`:1339` 同款 `\|\|` 回填（既有行为，本轮不改，记账） |
| `api.negativePreset` | 不消费 | **消费**（同上契约回填；与结构负面做词条级去重，出厂词不双份） | 消费：`:1401` / `:1359` 同上 `\|\|` 回填 |
| `ucPreset: 0` | —（general/chat 无此字段） | **保持 0**（选 C，§五.4） | 同 |
| builtin 视觉层（`SLEEPY_FORMAL_*` / `SLEEPY_VISUAL_STYLE`） | 消费：`:487-488`（01）、`:503-505`（02 男/女/中性）、`:521-522`（03/04） | NAI 用 §三 tag 化候选（独立常量，不覆盖 General 原稿） | 不消费 |
| custom 视觉层（`sleepy_img_style_custom`） | `:421-423` 读取；**空串 = 合法空**（不回退内置） | 同一契约 | 不消费 |

**空值语义**：正式路径里「未配置」（键不存在）与「用户明确留空」（空串）已统一为
空串 = 合法空、不回填（`imgStyleCustom()` 返回 `String(store.get(...) || '')`，语义一致）。
**风险点只在 legacy 的 `||` 回填链**（`:1339`/`:1359`/`:1379`/`:1401`），既有行为、
本轮不动、只记账；**新代码一律不引入新的 `||` 自动回填**。

### 6.2 请求字段消费：buildFormalNaiRequest → requestNai

Schema 事实（`image.novelai.net/docs/doc.json`，2026-10-02 实取；**全部字段无
description、无 default、无 required**——schema 未写默认 ≠ 已验证默认）：
**实际发送口径**：发送的字段显式取值；省略的字段（`centers` / `legacy_uc`）
**整字段不发**，而不是传空值凑「全部显式」。`use_coords:false` / `use_order:true`
是**本地实现选择**（不做坐标定位、按列表顺序，与官方多人文档的顺序行为一致），
**远端实际行为待真图验证**，不标成官方已确认默认：

- `image.ImageGenerationRequest` = `{ action:string, input:string, model:string, parameters:RequestParameters, url:string }`
- `image.RequestParameters` ⊃ `{ negative_prompt:string, ucPreset:integer, v4_prompt:V4ConditionInput, v4_negative_prompt:V4ConditionInput }`
- `image.V4ConditionInput` = `{ caption:V4ExternalCaption, legacy_uc:bool, use_coords:bool, use_order:bool }`
- `image.V4ExternalCaption` = `{ base_caption:string, char_captions:[V4ExternalCharacterCaption] }`
- `image.V4ExternalCharacterCaption` = `{ char_caption:string, centers:[{x:number, y:number}] }`

| 字段 | 来源 | 处理依据 |
|---|---|---|
| `input` | 编译后的 base prompt 全文（§二图） | V4 档与 `v4_prompt.caption.base_caption` **同值**发送（官方示例形态）；V3 只发 `input` |
| `negative_prompt` | 编译后的正式负面（质量 + 结构，§二/§三） | **不含** `api.negativePreset`、**不含**官方 UC 清单（选 C） |
| `v4_prompt` | 仅 V4/V4.5 档：`{ caption:{ base_caption: input, char_captions: perSubject() }, use_coords:false, use_order:true }` | schema 无默认值 → 发送字段显式取值；`use_coords:false`/`use_order:true` 为本地实现选择（远端待验） |
| `char_captions[i]` | `{ char_caption: 'girl'/'boy' + 该主体锁脸 tag；未知性别 → 不写性别词只写外貌，centers 省略 }` | 顺序 = subjects 数组顺序（A→B→C→D，与 page 人物框顺序一致）；`centers` 仅 `use_coords:true` 有意义，我们不做定位 → 省略字段 |
| `v4_negative_prompt` | 仅 V4 档：`{ caption:{ base_caption: 与 negative_prompt 同文, char_captions: [] }, use_coords:false, use_order:true }` | 正负面对应：负面**只有 base 一份**，per-char 负面暂不发（char 泄漏治理是后续项）；`legacy_uc` **不发**（schema 无默认，不猜） |
| `ucPreset` | 维持现值 `0`（`:1622`） | 选 C |
| `model` | `api.model` 原样 | 只认 `NAI_MODELS`（`:264-269`：4-5-full / 4-full / 3 / 4-5-curated-preview）；不在名单 → **明确报错零请求**，不扩新版本 |

### 6.3 拟替换代码（最小 diff，未应用）

**(1) generate 路由**（`imggen.js:1477-1486` 现文）：

```js
    if (opts.plan && api.kind !== 'nai') {
      var formal = buildFormalPrompt({ api: api, plan: opts.plan, extras: opts.extras });
      if (formal && formal.ok === false) {
        return Promise.resolve({ ok: false, error: formal.error });
      }
      if (formal && formal.ok) {
        return requestAndStore(api,
          { positive: formal.positive, negative: formal.negative }, opts.size);
      }
    }
```

拟替换：

```js
    if (opts.plan) {
      /* NAI 正式编译：校验失败 / 编译异常 / 模型不支持 → 明确报错零请求，
         本分支一律不回落 legacy。 */
      if (api.kind === 'nai') {
        var fnai = buildFormalNaiRequest({ api: api, plan: opts.plan });
        if (fnai.ok) {
          return requestAndStore(api,
            { positive: fnai.request.input, negative: fnai.request.negative,
              v4Prompt: fnai.request.v4Prompt,
              v4NegativePrompt: fnai.request.v4NegativePrompt },
            opts.size);
        }
        return Promise.resolve({ ok: false, error: fnai.error });
      }
      var formal = buildFormalPrompt({ api: api, plan: opts.plan, extras: opts.extras });
      if (formal && formal.ok === false) {
        return Promise.resolve({ ok: false, error: formal.error });
      }
      if (formal && formal.ok) {
        return requestAndStore(api,
          { positive: formal.positive, negative: formal.negative }, opts.size);
      }
    }
```

连带：`:416` 的 `if (api.kind === 'nai') return null;` **保留**（注释改为
「纯函数层保护」）——generate 不再走它，但直接调用 `buildFormalPrompt` 的
调用方（smoke `:2795` 断言）仍拿到 null，不会误用 General 词；
general/chat 分支后原 `formal && formal.ok` 守卫保留不动（不扩 diff）。

**(2) requestNai 请求体**（`imggen.js:1611-1625` 现文）：

```js
      body: JSON.stringify({
        input: built.positive,
        model: api.model || 'nai-diffusion-3',
        action: 'generate',
        parameters: {
          width: w,
          height: hgt,
          scale: 5,
          sampler: 'k_euler_ancestral',
          steps: 28,
          n_samples: 1,
          ucPreset: 0,
          negative_prompt: built.negative || ''
        }
      })
```

拟替换（V4 档追加两个参数字段；**V3 一字不加**）：

```js
      body: JSON.stringify({
        input: built.positive,               /* 编译器产出：base prompt 全文 */
        model: api.model || 'nai-diffusion-3',
        action: 'generate',
        parameters: {
          width: w,
          height: hgt,
          scale: 5,
          sampler: 'k_euler_ancestral',
          steps: 28,
          n_samples: 1,
          ucPreset: 0,                       /* 选 C：维持现状 */
          negative_prompt: built.negative || '',
          v4_prompt: built.v4Prompt || undefined,
          v4_negative_prompt: built.v4NegativePrompt || undefined
        }
      })
```

（这里 `|| undefined` 只做「字段不存在 → 不发送」的展开：`v4Prompt` 是对象、
V3 恒为缺省 → JSON.stringify 丢掉 undefined 键，不是空值回填。）

**(3) `buildFormalNaiRequest(opts)`**（新函数，放 `buildFormalPrompt` 之后）：

- 校验：`validatePlanSubjects(plan)`（从 `buildFormalPrompt` `:429-480` 的 §五
  校验块抽出：重复 entityId / `expectedSubjectCount` 严格相等 / >4 拦 /
  0 人报 person 拦——General 与 NAI **共用，不抄第三份**）；另加：
  `api.model` 不在 `NAI_MODELS` → 明确报错零请求。
- 编译：V3 → `{ input, negative }`；V4/V4.5 → `{ input, negative, v4Prompt, v4NegativePrompt }`（§6.2 表）；
  人数聚合按 §四.2；身份隔离、sender 不参与主体，沿用 `subjectForChar/subjectForUser` 现状；
  custom 空/非空契约与 General 一致（不混内置视觉层、不改已存文本）。
- 返回 `{ ok:true, request }` 或 `{ ok:false, error }`——**没有第三种 null 形态**
  （不支持的组合 = error，不回落）。

### 6.4 无 plan 的既有兼容入口（单列，不声明获得新校验）

- 试一张 legacy 档：`page-imggen.js` `req = imggen.generate({ api: collect(), subject: subject, extras: extras })`；
- AI 解析失败兜底：`page-chat.js` genAndDeliver 的 `plan ? generate({plan}) : generate({subject…})`
  分支，moments-ai / page-diary 的 `else` legacy 分支（subject/faceText 直拼）。

这些保持现状：本轮**不加**校验、**不宣称**覆盖；其中 legacy `||` 回填链的空值
行为见 §6.1 记账。

## 七、零付费验收清单（复用既有拦截测试骨架）

- 断言实际 URL、model、最终 base prompt / negative / v4_prompt / v4_negative_prompt
  的逐字段内容（不只断成功返回）。
- **「拒绝后零请求」断言**：校验失败（重复主体 / 人数不符 / 失效主体 /
  >4 人 / 0 人报 person / 模型不在 `NAI_MODELS`）每种都断言
  `route` 拦截计数**不变**——不发任何网络请求、也**不出现 legacy 形态的
  请求正文**（`{p}` 占位 / BUILTIN_PRESET 词头出现即失败）。
- 覆盖：无人、单人男/女、含未知性别主体、男女双人、同性双人、3/4 人；
  失效主体与声明人数不符在**发请求前**停止。
- custom 空/非空不混内置；user 马甲与 char 来源不串用；
  **接口预设不混入正式请求**（positive/negative 里不出现 `api.positivePreset`
  的词头）；`ucPreset` 断言仍为 0；V3 / V4 / V4.5 字段隔离
  （V3 请求体无 `v4_prompt`/`v4_negative_prompt` 键）。
- 最终输出回传无人、单人、双人、4 人各一份**脱敏请求样本**
  （不含 token、密钥、个人资料）。

## 八、上一轮三项待闭合的证据引用（不重复开工程）

1. **未知性别 1girl 来源**：已核查闭合——纯函数实取 `has1girl:false`；
   `gender=''` → `genderTagOf` 空串，系统对未知性别**没有默认补齐**；
   smoke/revamp 已加反向断言（未知性别请求含 1girl/1boy 即失败）。
   证据：`.workbuddy/memory/2026-10-01.md`「发布前定点核查」第 1 条。
   （「明确非人但 gender 有值」的路由仍开放，见 §五.4 附带待决项。）
2. **general/chat 实际通道与 3/4 人 custom 覆盖**：已闭合——revamp 测试
   每 case 断言 `route.request().url()`（通道）+ 最终正文；2/3/4 人 ×
   general/chat builtin 全覆盖（A9-A15）；3/4 人 custom 空/非空不混入（A16-A19）；
   34 ✓ 0 ✗。证据：同上第 3 条。
3. **AI 外貌迟到响应 / 旧草稿覆盖保护**：已闭合——page-idcard.js 请求时
   快照字段/人设/材料版本，响应后与采用时都比较，标旧横幅 + 「仍要采用」
   再确认，不静默覆盖；`panel.isConnected` 第一层；route 延迟 700ms 造
   在途窗口，B10a/b/c 断言。证据：同上第 4 条。
