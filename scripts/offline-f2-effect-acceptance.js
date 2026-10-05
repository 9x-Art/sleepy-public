#!/usr/bin/env node
/* ============================================================
   scripts/offline-f2-effect-acceptance.js
   —— 私聊线下 F2「模型效果」真机验收（第一批：链路探路）

   ⚠️ 本脚本**不改任何生产代码**。它只：
     1. 在无头 Edge 里打开当前工作区的真实页面；
     2. 通过 **store.set('mainApi', …)** 注入真实 API 配置
        （凭据只从环境变量读，**绝不写进任何文件**）；
     3. 走**真实发送链**（填输入框 → 点发送 → callModel → 真实 requestOnce）；
     4. 记录**模型原始输出** + **当次诊断摘要**。

   ★ 严禁：用 mock 顶替真实生成、用夹具代替真实请求。
     本脚本**不注入任何 requestOnce 桩** —— 这是它与
     browser-offline-f2-req-test.js 的根本区别（那份验接线，这份验效果）。

   跑法（凭据必须走环境变量，不要写进命令行历史以外的任何地方）：
     SLEEPY_API_BASE="https://…/v1" \
     SLEEPY_API_KEY="sk-…" \
     SLEEPY_API_MODEL="…" \
     NODE_PATH=<managed workspace>/node_modules \
       node scripts/offline-f2-effect-acceptance.js

   可选：
     SLEEPY_EFFECT_OUT=<目录>     样本落盘目录（默认 docs/样本-private-f2-效果/）
     SLEEPY_EFFECT_TAG=<标签>     批次标签（默认 探路）
     SLEEPY_EFFECT_GROUP=<编号>   只跑某一组（默认全部）
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var BASE = process.env.SLEEPY_TEST_URL || 'http://127.0.0.1:5173/';

var API_BASE = process.env.SLEEPY_API_BASE || '';
var API_KEY = process.env.SLEEPY_API_KEY || '';
var API_MODEL = process.env.SLEEPY_API_MODEL || '';
/* ★ 输出预算：只改**测试配置**里的 maxTokens，提示词/协议/其他参数一律不动。
   为什么需要它：GLM-5.2 深度思考默认开启，maxTokens=1024 会被推理吃满
   （实测 reasoning 1020 / completion 1024、finish_reason:length、content 为空）。
   ⚠️ 这是**提高预算**，不是新增思考开关/推理参数 —— 后者本批明确不做。 */
var MAX_TOKENS = Number(process.env.SLEEPY_EFFECT_MAXTOKENS || 8192);

/* ★★★ 用户批准的参数（P1 · 2026-10-04）—— **唯一出处**。
   页内注入与发出前核对**都读这一份**，避免两处写死导致漂移。
   ⚠️ 这几个值同时也是「发出前核对」的期望值；改动这里等于改动批准参数，
      必须重新获得用户许可。 */
var APPROVED = {
  temperature: 0.85,
  maxTokens: MAX_TOKENS,
  contextMessages: 40,
  stream: false,
  timeoutSec: 120
};

var TAG = process.env.SLEEPY_EFFECT_TAG || '探路';
var ONLY = process.env.SLEEPY_EFFECT_GROUP || '';
var OUT_DIR = path.resolve(ROOT,
  process.env.SLEEPY_EFFECT_OUT || 'docs/样本-private-f2-效果');

/* ★ 全局真实模型请求预算（2026-10-05）
   —— 「只允许发 N 次」的上限，注入到页内 fetch 闸。
   未设 = 不启用（保持既有行为）。设了之后：自动开场 / 重试 /
   候选回退 / 后台模型调用统统走同一道闸，第 N+1 次直接 reject。 */
var BUDGET_LIMIT = Number(process.env.SLEEPY_EFFECT_BUDGET || 0) || null;

/* ★ 只跑前 N 轮（2026-05-30 用；单轮验收时避免连发）
   —— GROUPS 的 turns 会被切到前 N 条，其余轮次根本不进入调度。 */
var MAX_TURNS = Number(process.env.SLEEPY_EFFECT_MAX_TURNS || 0) || 0;

/* ★ 被 require（零网络测试）时**不要在这里退出** ——
   缺凭据 / 缺 playwright 对纯函数测试是正常的。
   只有「直接 node 运行」才走 SKIP 早退。 */
var IS_MAIN = (require.main === module);

if (!API_BASE || !API_KEY || !API_MODEL) {
  if (IS_MAIN) {
    process.stdout.write('SKIP：缺凭据。需要三个环境变量：\n' +
      '  SLEEPY_API_BASE / SLEEPY_API_KEY / SLEEPY_API_MODEL\n');
    process.exit(0);
  }
}

var chromium = null;
try { chromium = require('playwright-core').chromium; }
catch (e) {
  if (IS_MAIN) {
    process.stdout.write('SKIP：playwright-core 不可用（' + e.message + '）\n');
    process.exit(0);
  }
}

/* ---------- 旁路采集模块的**源码文本**（页内 eval 用）----------
   ★ 为什么读文本而不是把函数体抄进 evaluate：
     采集逻辑必须与 Node 侧单测**跑同一份实现**。
     抄一遍 = 测的和发的可能不是同一个东西（这类漂移最难发现）。
   ★ 用 new Function 求值而非直接 eval：间接 eval 已在上面用 (0,eval)，
     这里只负责把文本变成全局对象 window.F2BodyCapture。 */
var CAPTURE_SRC = fs.readFileSync(
  path.join(__dirname, 'lib', 'f2-body-capture.js'), 'utf8');

/* ---------- 停机建议：Node 侧的同一份判定 ----------
   ★ 页内旁路自己也有一份 stopKindForSend（在 CAPTURE_SRC 里）。
     这里**从同一份源码文本里求值**，不另抄一遍 ——
     抄一遍就会出现「页内判 link、Node 判 null」的分裂口径。
   ★ 用途：轮记录里带一个「建议」，供人看；**真正执行停机的是
     hardStopKind**（它还额外看 403 / network / 诊断缺失）。 */
var STOP_KIND_FOR_SEND = (function () {
  var mod = { exports: {} };
  try {
    /* 同一份源码在 Node 里求值，取出 stopKindForSend。
       ⚠️ 必须用 vm（CAPTURE_SRC 顶层的 UMD 写法依赖 module/window 双出口）。 */
    var vm = require('vm');
    var sandbox = { module: mod, exports: mod.exports, console: console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CAPTURE_SRC, sandbox, { filename: 'f2-body-capture.js' });
    return sandbox.F2BodyCapture.stopKindForSend;
  } catch (e) {
    /* 取不到就退化成「只判记录写入失败」，不静默返回恒 null */
    return function (send) {
      return (send && send.记录写入失败) ? 'link' : null;
    };
  }
}());

/* ---------- 凭据脱敏：任何落盘/打印前都过这里 ---------- */
function maskKey(k) {
  if (!k) return '';
  var s = String(k);
  return s.slice(0, 4) + '…' + s.slice(-2) + '（len' + s.length + '）';
}
function maskUrl(u) {
  if (!u) return '';
  /* 把 URL 里可能出现的 key 类 query 参数打掉 */
  return String(u).replace(/([?&](?:key|api_key|token|access_token)=)[^&]*/gi,
    '$1***');
}

/* ============================================================
   夹具：同一角色、同一关系、同一场景
   —— 五组样本共用它，唯一变量是「user 说了什么」。
   ============================================================ */

var FIXTURE = {
  /* ★ user 的性别与称谓：第一批没约束，模型自行把 user 定成女性
     （组2轮1 出现「他抬眼看了她一下」）—— 这不是模型缺陷，是夹具缺陷，
     但会让后续样本失去可比性。本批**全程用中性称谓「对方」**。 */
  userRef: '对方',
  char: {
    id: '__f2eff_role__',
    kind: 'main',
    name: '沈砚',
    content: [
      '沈砚，三十一岁，建筑设计师。习惯用精确的尺寸和材料名说话，很少用形容词。',
      '左手小指有一道旧疤，是他十岁那年自己摔的，从没提过原因。',
      '不擅长安慰人。有人难过时他更倾向于把事情拆成可执行的步骤，而不是说「别难过」。',
      '对亲密的人会记得对方说过的小事，但从不主动提起自己。',
      '脾气来得快去得也快，吵架时话很硬，但从不摔门。',
      '有慢性失眠，凌晨三点还醒着的时候会在纸上画平面图。',
      '⚠️ 不预设对方的性别与称谓 —— 叙述里一律用「对方」，不猜、不代称。'
    ].join('\n')
  },
  /* 场景前置：明确写出地点、时间、在场 NPC、已发生的动作 ——
     这样「连续三轮」才能看出模型是否重复已完成动作。 */
  scene: {
    id: '__f2eff_scene__',
    sceneName: '雨夜的旧书店',
    location: '城西旧书店二楼阁楼',
    timeOfDay: '深夜',
    weather: '雨',
    clockTime: '23:40',
    openingBy: 'char',
    pendingSetup: false
  },
  /* 在场 NPC：第 5 组样本要验「NPC 是否无故消失 / 知道不该知道的 /
     被写成只服务主角的工具」——必须先有一个明确的在场者。 */
  npc: {
    id: '__f2eff_npc__',
    name: '老板娘',
    content: '旧书店老板娘，四十多岁，话不多，泡茶很好喝。' +
      '她知道沈砚每逢周三来买一本画册，但从不多问。'
  },
  /* 前置：进阁楼前已发生的事（模型不得重复「进门」这个已完成动作） */
  preActions: [
    '沈砚已经推开阁楼的门上来了，雨水顺着他的外套下摆往下滴。',
    '老板娘在楼下喊了一声「茶刚泡好」，然后就没有再上来。',
    '沈砚已经把湿外套搭在椅背上了。'
  ]
};

/* user 的五组输入 —— 全部保持极短、极平淡，
   目的恰恰是看模型会不会擅自加戏。

   ★★★ P0/P1 分组（v2）：**两个独立会话**，不是一条连续会话。
   ⚠️ 曾经的表述矛盾：「4 轮、1 组连续会话」但实际是 G4 三轮 + G7 另起一组。
     若 G7 接着 G4 的会话跑，G7 会继承 G4 的现场上下文 ——
     而 G7 要验的正是「复杂输入下规则会不会互相打架」，
     带着前 3 轮的上下文就污染了判据。
     → 每个 GROUPS 条目 = 一个**独立会话**（独立 context + 独立 page）。 */
/* ============================================================
   P3 单臂矩阵 · 7 组 17 轮（2026-10-05 冻结）
   ------------------------------------------------------------
   ★ 每个 GROUPS 条目 = 一个**独立会话**（独立 context + 独立 page）。
     脚本已实现：换组时 close 掉旧 page、newPage() 开新 context。
   ★ 轮数 = 3/2/2/3/2/3/2 = 17，逐轮一对一，**无扇出**。
   ★ `rerunAfterFix` 标记：G4/G7 的第 1 轮在 P1 跑过，但**那是修复前**
     （`我到了。` 当时在出站 body 里出现两次）。⇒ 本轮**重新发送**，
     且**禁止**把 P1 的旧样本当成本次新样本（见 report 口径段）。
   ============================================================ */
var GROUPS = [
  {
    id: 1,
    key: 'P3-G1-C1现场承接-3轮',
    case: 'C1',
    rule: 'N',
    goal: '验是否从已成立现场继续；★ 是否重演已完成动作；位置·物品·时间先后是否连续',
    turns: [
      /* 前 2 轮刻意不提任何新动作 ⇒ 让「重演」这个坏行为无处可藏。
         若输入里写了新动作，模型跟着做是正常的，就验不出它会不会擅自重演。 */
      '我到了。',
      '嗯。',            /* 单字：给「不注水」施压 */
      '你接着说。'        /* 明确交回推进权 */
    ],
    watch: [
      '是否重演已完成动作（再推门 / 再脱外套 / 再坐下）',
      '位置·物品·时间先后是否连续',
      '是否从最近剧情往下写，而不是重开场景、复述背景'
    ]
  },
  {
    id: 2,
    key: 'P3-G2-C2性格与生活状态保持-2轮',
    case: 'C2',
    rule: 'P',
    goal: '★ 跨轮**趋势**判据（不逐轮要求）：基调一致、人设特征分布在不同轮次、不滑向通用体贴人设',
    turns: [
      /* 两轮都不给情绪刺激，只给中性日常 ⇒ 逼模型露出自己的默认说话方式。
         轮 1 是陈述事实、**不求助** ⇒ 看是否用尺寸/材料名回应、是否给通用安慰。 */
      '这楼上的灯太暗了。',
      '嗯。'             /* 单字、不给话题 ⇒ 人设特征是否换个方式再出现一次（分布 ≠ 复读） */
    ],
    watch: [
      '整体基调是否与资料一致（克制、具体、少形容词）',
      '人设特征是否**分布在不同轮次**（不要求每轮都有）',
      '是否滑向通用体贴人设（如突然说「别难过」）',
      '★ 否决项：编造旧疤原因 / 把 char 心理写成客观事实陈述 / 无依据读 user 内心',
      '★ 记 2/1/0 **必须写出这轮出现了哪一处人设证据、落在第几轮**，不许只写档位'
    ]
  },
  {
    id: 3,
    key: 'P3-G3-C3篇幅自适应-2轮',
    case: 'C3',
    rule: 'L',
    goal: '验篇幅是否跟着输入信息量走，而不是固定模板',
    turns: [
      /* 两轮信息量差必须拉大 —— 这是唯一能验出「篇幅是否自适应」的配对方式 */
      '嗯。',                                              /* 极小 ⇒ 期望短，不许注水 */
      '我下周再来。今天先走了。'                            /* 中等 ⇒ 允许展开但不靠转折填长 */
    ],
    watch: [
      '输入短 → 不许注水',
      '信息量大 → 允许展开，但**不靠增加转折填长**',
      '是否按人数平均分配篇幅',
      '长篇是否**可以停在同一时刻**',
      '★ 是否跨轮固定同一篇幅（模板化）',
      '⚠️ 本组**不判 M1**（轮 2 顺带为 G6 埋线，但 M1 归 G6，避免一输入两处判）'
    ]
  },
  {
    id: 4,
    key: 'P3-G4-C4-user主体性-3轮',
    case: 'C4',
    rule: 'S2+B',
    goal: '验 user 选择空间是否被替代；替 user 决定 / 代写台词心理 / 推进到需回应处是否停住',
    turns: [
      /* 轮次标记绝不写进输入 —— 第一批写了「（第二轮）」被模型看见，污染复读判据 */
      '我到了。',
      '我坐下了。',
      '算了，你看着办。'   /* ← 关键轮：最容易诱发「替 user 决定」 */
    ],
    /* ★ 第 1 轮在 P1 跑过，但那是**修复前**（出站 body 里 user 输入重复两次）。
       本轮**重新发送**，以保证整组 3 轮出自同一份代码、同一套采集。 */
    rerunAfterFix: {
      轮: 1,
      原因: 'P1 样本为修复前（出站 body 重复 user），不可当本次新样本',
      旧样本处置: 'P1 修复前旧样本：排除，不计入 P3 统计；'
        + '本轮修复后重新发送样本：计入 P3 正式统计。',
      是否额外追加: false
    },
    watch: [
      '是否替 user 决定、同意、拒绝、起身、走开',
      '是否代写 user 的台词 / 心理 / 身体反应',
      '推进到需要 user 回应处**是否停住并保留可回应的位置**',
      'suggests 是否站在 user 视角、有没有替 user 把选项排好'
    ]
  },
  {
    id: 5,
    key: 'P3-G5-C5心理≠事实-2轮',
    case: 'C5',
    rule: 'B',
    goal: '验 F1（把对 user 动机的猜测写成客观事实）与 F2（无依据断言 user 情绪/内心）',
    /* ★★ 全矩阵里**仅有的两个「纯动作无锚点」输入**（2026-10-05 冻结）。
       为什么必须是纯动作：陈述句里 user 已把语义说尽，模型只需顺着走，
       **不会产生「猜测」** ⇒ F1/F2 无处可判。
       纯动作只给可观测、不给情绪/理由 ⇒ 模型**必须自己解释**，禁区才可达可判。 */
    turns: [
      '（我把杯子往他那边推了推。）',   /* 轮 1 主判 F1 */
      '（我笑了一下，没接话。）'        /* 轮 2 主判 F2 */
    ],
    /* ★ 本组的判分**不走通用 0/1**，见 C5_JUDGE 五档。
       关键：合规与违规的差别**不在内容**（「让他先喝」两边都可能有），
       **而在叙述方式** —— 有没有「猜/觉得/不知道/大概」这类主观标记。 */
    judge: 'C5',
    watch: [
      'F1 违规：把对 user **动机**的猜测写成客观事实（「她把杯子推过来，是想让他先喝。」）',
      'F1 合规：只描述可观测（「杯子被推到他面前。」）或带主观标记（「他猜她大概是想让他先喝。」）',
      'F2 违规：**无依据断言** user 情绪/内心（「她心里其实很难过，只是不想让气氛更难。」）',
      'F2 合规：可观测描述，或基于可观测行为**且带不确定标记**的推断（「她好像不太想接话。」）',
      '★ 证据不足：主语归属不明，分不清是角色猜测还是客观叙述 ⇒ **不判分**',
      '★ 未触发：全程未涉及 user 内心 / 未对动作下判断 ⇒ **不等于「通过」**',
      '⚠️ 本组**不判 M1/M2/M3/M4**（那是 G6）；同句兼涉记忆/未来断言与猜测事实化 ⇒ **归 G6**'
    ]
  },
  {
    id: 6,
    key: 'P3-G6-C6即时动作≠长期记忆-3轮',
    case: 'C6',
    rule: 'B',
    goal: '验即时动作是否被推断成频率/常态/未来事实/状态字段',
    turns: [
      '我下周再来。',      /* 埋线：user 明确说过的计划（M1 的合规样本） */
      '今天雨停了。',      /* 中性填充 */
      '我走了。'           /* ★ 触发点：看 1 的计划会不会被滥用 */
    ],
    watch: [
      'M1 **允许**：记住 user 明确说过的计划（不记得**不算违规**，只是没用到规则）',
      'M2 违规：把一次动作推断成频率/常态（「她每周三都来」——user 只说过一次）',
      'M3 违规：宣告未来已发生（「下周她果然来了」——user 没给那次经历）',
      'M4 违规：把即时动作固化成状态字段（envUpdate / 长期约定里写死）'
    ]
  },
  {
    id: 7,
    key: 'P3-G7-C7复杂输入不被冲垮-2轮',
    case: 'C7',
    rule: '五段',
    goal: '验五段规则互相打架 / 被当模板照抄 / 篇幅暴涨 / 禁止项被违反；★ 回指不存在的对象时是否编造',
    turns: [
      /* 轮 1 = P1 已跑过的复合长输入，**本轮重新发送**（P1 那次是修复前） */
      '你还记得我们第一次见面那天我跟你说过什么吗。我今天有点累。' +
      '能不能帮我把阁楼那扇窗关一下，风一直吹进来。' +
      '算了你随便吧，不关也行。对了你别跟楼下的人提我今天来过。',
      /* ★ 轮 2「回指压力」：user 说了个**上下文里不存在**的指代对象。
         这是唯一能验 N（区分信息是否成立）的输入 ——
         看模型是顺着不存在的指代编下去，还是停下来问。 */
      '你刚才说的那个，我再想想。'
    ],
    rerunAfterFix: {
      轮: 1,
      原因: 'P1 样本为修复前（出站 body 重复 user），不可当本次新样本',
      旧样本处置: 'P1 修复前旧样本：排除，不计入 P3 统计；'
        + '本轮修复后重新发送样本：计入 P3 正式统计。',
      是否额外追加: false
    },
    watch: [
      '五段规则是否互相打架（如 N 保留回应位置 vs S2 推进现场）',
      '规则有没有被当模板照抄进正文（「本轮」「按照设定」这类元叙述）',
      '篇幅是否暴涨（规则堆叠 → 输出变长）',
      '★ 明确禁止项（别跟楼下的人提）有没有被违反',
      '★ 含糊项（「随便吧，不关也行」）有没有被替 user 定死',
      '★ 回指不存在的对象（「你刚才说的那个」）时，是否顺着编造'
    ]
  }
];

/* ============================================================
   C5 五档判分（G5 专用，2026-10-05 冻结）
   ------------------------------------------------------------
   ★ 为什么不用通用 0/1：F1/F2 的核心是「叙述方式」而非「内容对错」，
     二值判分会把「未触发」折算成「通过」—— 用模型没犯错冒充规则被验证过。
   ★ 五档互斥、每档都要求**摘出原文句子**；「未触发」与「合规」**必须分开记**。
   ============================================================ */
var C5_JUDGE = {
  F1违规: 'F1违规',           /* 对 user 动机的猜测被写成客观事实 */
  F2违规: 'F2违规',           /* 无依据断言 user 情绪/内心 */
  合规: '合规',               /* 只描述可观测，或带主观标记的推测 */
  证据不足: '证据不足',       /* 分不清归属 ⇒ 不判分（方案 §3.2） */
  未触发: '未触发'            /* 全程未涉及 user 内心 ⇒ **不算「通过」** */
};
var C5_JUDGE_ALL = [C5_JUDGE.F1违规, C5_JUDGE.F2违规, C5_JUDGE.合规,
  C5_JUDGE.证据不足, C5_JUDGE.未触发];
/* 各档的判定规则（报告与判分表共用同一份，禁止另写一套） */
var C5_JUDGE_RULE = {
  F1违规: '主判 F1 的轮次：动机断言被写成客观事实（无 猜/觉得/不知道/大概 类标记）',
  F2违规: '主判 F2 的轮次：无依据断言 user 具体情绪/内心状态',
  合规: '只描述可观测，或推断带明确主观标记 ⇒ 未命中禁区',
  证据不足: '有判断但主语归属不明 / 分不清 F1 还是 F2 ⇒ 不判分',
  未触发: '全程未涉及 user 内心、未对动作下判断 ⇒ 未触发，**不等于通过**'
};

/* ============================================================
   页内：建夹具（虚构角色/会话，不读任何真实存档）
   ============================================================ */
var SETUP = function (arg) {
  var f = arg.f;
  var core = Sleepy.core;
  var sb = core.listSandboxes()[0];

  var ch = core.upsertChar({
    id: f.char.id, kind: 'main', name: f.char.name,
    content: f.char.content, sandboxId: sb && sb.id
  });
  var npc = core.upsertChar({
    id: f.npc.id, kind: 'main', name: f.npc.name,
    content: f.npc.content, sandboxId: sb && sb.id
  });

  /* ------------------------------------------------------------
     ★★ 场景持久化：两条**正式**入口，2026-10-05 修
     ------------------------------------------------------------
     旧写法（**静默失效**）：
         var s2 = findSession(s.id);
         s2.sceneName = …;  s2.env = …;
     `findSession` 内部 `allSessions() → store.get`，而 **`store.get` 返回
     深拷贝** ⇒ 拿到的是**孤儿副本**，直接赋值**不落库**。
     结果五个现场字段全部退回 `createSession` 的默认值
     （未命名场景 / — / 傍晚 / 晴 / 16:42），
     装配快照里读到的也是这些默认值 —— 但**这不等于**模型当时收到了它们。

     ⚠️ 生产的深拷贝是**设计如此**（否则外部能改内部状态）——
        要改的是这里的调用方式，不是 store。

     核实过的两个正式入口（已用行为验证，不是照源码猜的）：
       ① `createSession(charId, form)` 的 **form 参数**认这五个字段
          （page-offline.js:153–160）——**创建时一次写全**，最稳。
       ② `offlineStore.updateEnv(id, patch)` → `mutateSession` → `saveAll`，
          能落库，但**只管 `env` 里的四个**。
     ⚠️ **`updateEnv` 传 `sceneName` 会被静默忽略**（不报错、不生效）——
        实测确认过。所以场景名只能走 ①。
     ------------------------------------------------------------ */
  var s = Sleepy.offlineStore.createSession(ch.id, {
    openingBy: f.scene.openingBy,
    pendingSetup: f.scene.pendingSetup,
    /* 正式创建参数：场景名 + 四个现场值一次写全 */
    sceneName: f.scene.sceneName,
    location: f.scene.location,
    timeOfDay: f.scene.timeOfDay,
    weather: f.scene.weather,
    clockTime: f.scene.clockTime
  });

  /* 再用 updateEnv 显式 reaffirm 四个 env 值（走已验证的保存入口）。
     这一步是**冗余但有意的**：万一将来 createSession 的 form 参数改名，
     updateEnv 这条路仍然有效，且下面的自检会把不一致**抓出来**而不是静默通过。 */
  Sleepy.offlineStore.updateEnv(s.id, {
    location: f.scene.location, timeOfDay: f.scene.timeOfDay,
    weather: f.scene.weather, clockTime: f.scene.clockTime
  });

  /* ★★★ 自检：写完立刻**回读**核对，不对就抛。
     为什么必须在这里抛而不是留给测试看：
       静默失效是这个 bug 的本质 —— 如果 SETUP 悄悄写不进去，
       后面每一轮都会用错误的现场值去跑，**烧掉的请求全是废的**。
     宁可第一轮就炸，也不要跑完三组才发现现场值从头到尾都是默认值。 */
  (function verifyScenePersisted() {
    var back = Sleepy.offlineStore.findSession(s.id);   /* 走 store 深拷贝回读 */
    if (!back) throw new Error('SETUP 自检：会话回读不到（id=' + s.id + '）');
    var bad = [];
    function chk(name, got, want) {
      if (got !== want) bad.push(name + '：期望 ' + JSON.stringify(want) +
        '，实得 ' + JSON.stringify(got));
    }
    chk('sceneName', back.sceneName, f.scene.sceneName);
    chk('env.location', back.env && back.env.location, f.scene.location);
    chk('env.timeOfDay', back.env && back.env.timeOfDay, f.scene.timeOfDay);
    chk('env.weather', back.env && back.env.weather, f.scene.weather);
    chk('env.clockTime', back.env && back.env.clockTime, f.scene.clockTime);
    if (bad.length) {
      throw new Error('SETUP 自检失败（现场值没落库，**不要继续发请求**）：\n  ' +
        bad.join('\n  '));
    }
  }());

  /* ------------------------------------------------------------
     前置消息：user 2 条 + preActions 逐条 3 条 + 现场 1 条，顺序固定
     ------------------------------------------------------------
     2026-10-05 收口：上一轮修持久化时，把原先写进孤儿副本（因而未落库）的
     5 条历史写入**也**改走 appendMessage，结果落库从 4 条变 9 条，
     `preActions` 出现两次（逐条 3 条 + 拼接 1 条）———
     同一段现场动作在模型上下文里重复了一遍。

     ★ 2026-10-05 裁决（用户拍板）：**保留逐条、删除拼接版，不保留两份**。
       拼接版只是 `f.preActions.join(' ')` 的同源重复装配，没有独立语义
       或唯一协议字段（preActions 还经「已发生的前置动作」元数据通道
       单独留存，信息不丢）；逐条版保留每条动作的独立消息边界。
       铺垫类历史写入（老板娘没上来 / 坐下）维持不动。
     ⚠️ 这**不是**把代码退回孤儿副本写法（那种写法静默失效，是本轮要修的病根）
        —— 全部写入都走 appendMessage（已验证的落库入口）。 */
  Sleepy.offlineStore.appendMessage(s.id, { role: 'user', text: '（我推开阁楼的门，上来了。)' });
  f.preActions.forEach(function (pa) {
    Sleepy.offlineStore.appendMessage(s.id, { role: 'scene', paras: [{ type: 'prose', text: pa }] });
  });
  Sleepy.offlineStore.appendMessage(s.id, { role: 'scene', paras: [{ type: 'prose', text: '（老板娘在楼下，没有上来。）' }] });
  Sleepy.offlineStore.appendMessage(s.id, { role: 'user', text: '（我坐下了，湿外套搭在椅背上。）' });

  /* ★ 真实 API 配置：凭据来自 Node 侧注入，绝不落到磁盘 */
  Sleepy.store.set('mainApi', {
    name: '验收模型', baseUrl: window.__API_BASE, apiKey: window.__API_KEY,
    model: window.__API_MODEL,
    temperature: window.__APPROVED.temperature, maxTokens: window.__APPROVED.maxTokens,
    contextMessages: window.__APPROVED.contextMessages,
    stream: window.__APPROVED.stream,
    timeoutSec: window.__APPROVED.timeoutSec, enabled: true
  });

  window.__sid = s.id;
  Sleepy.nav.open('offline-scene', { id: s.id });
  /* 返回现场值，供调用方（测试/验收主流程）直接核对，不必再回读一次 */
  return {
    sid: s.id, charId: ch.id, npcId: npc.id,
    已写入现场: {
      sceneName: f.scene.sceneName,
      location: f.scene.location, timeOfDay: f.scene.timeOfDay,
      weather: f.scene.weather, clockTime: f.scene.clockTime
    }
  };
};

var SCENE_READY = function () {
  var p = document.querySelector('[data-page="offline-scene"]');
  return !!(p && p.classList.contains('is-active') &&
    document.querySelector('.off-input-field'));
};

/* 点真实发送按钮。返回发送是否真的发出去了。 */
var SEND = function (text) {
  var input = document.querySelector('.off-input-field');
  var send = document.querySelector('.off-send-btn');
  if (!input || !send) return { sent: false, why: 'no input/send' };
  input.value = text;
  if (send.disabled) return { sent: false, why: 'send disabled（可能上一轮未收尾）' };
  send.click();
  return { sent: true };
};

var BUSY = function () {
  var i = document.querySelector('.off-input-field');
  var b = document.querySelector('.off-send-btn');
  return !!(i && i.disabled) || !!(b && b.disabled);
};

/* 取这一轮之后的诊断（真实出站那次，不是预览） */
var DIAG = function () { return Sleepy.offlineDiag.snapshot(); };

/* 取会话里最新的 char/scene 消息原文 */
var LATEST = function () {
  var s = Sleepy.offlineStore.findSession(window.__sid);
  if (!s) return null;
  for (var i = s.messages.length - 1; i >= 0; i--) {
    var m = s.messages[i];
    if (m.role === 'char' || m.role === 'scene') {
      return {
        role: m.role,
        text: (m.paras || []).map(function (p) {
          return p.type === 'dialogue' ? '「' + p.text + '」' : p.text;
        }).join('\n'),
        paras: m.paras || []
      };
    }
  }
  return null;
};

/* ============================================================
   装配指纹（v2 · P0 补齐 · **零付费**，走本地装配不发请求）

   ★ 为什么必须有：这是「这批样本由哪个装配版本产出」的**唯一事后可核验凭据**。
     旧样本正因缺它而无法自证注了什么（见方案 §1.1）。
   ★ 为什么不落 system 全文：全文含用户 override 内容与角色资料，
     体积大且可能带隐私 → **只落指纹**。
   ★ 期望值**从生产模块导出**（behaviorText.forScenario），
     **不把运行结果抄成期望值**。
   ============================================================ */
var FINGERPRINT = function () {
  var S = window.Sleepy;
  var out = { 版本: null, 段命中: {}, 五段全在: false, systemSHA256: null, 备注: '' };
  var BT = S.behaviorText;
  if (!BT || typeof BT.forScenario !== 'function') {
    out.备注 = 'behaviorText 不可用'; return out;
  }
  out.版本 = BT.VERSION || null;
  var fs2 = BT.forScenario('offline');
  if (!fs2 || fs2.ok !== true) { out.备注 = 'forScenario(offline) 失败'; return out; }
  /* 找这一轮真实装配的 system 段：走生产装配器，不自己拼 */
  var sys = null;
  try {
    var s = S.offlineStore.findSession(window.__sid);
    var asmb = S.promptEngine.assembleOffline({
      charId: s.charId, userId: s.userId, session: s, userInput: '(指纹探查)'
    });
    /* ⚠️⚠️ 装配产出的是**多条** system 段（每槽一条，实测 12 条），
       **不是一条**。只取 messages[0] 会拿到 [CHARACTER] 段 →
       五段命中全 0 → 看起来像「装配没走共享层」，实际是取错了。
       （这个错我真犯过一次，是临时探针先发现的。）
       → 必须把**全部** system 段拼起来再找各模块正文。 */
    var parts = (asmb && asmb.messages ? asmb.messages : [])
      .filter(function (m) { return m && m.role === 'system'; })
      .map(function (m) { return String(m.content || ''); });
    out.system段数 = parts.length;
    sys = parts.join('\n');
  } catch (e) { out.备注 = '装配抛错：' + String(e && e.message); return out; }
  if (!sys) { out.备注 = '装配产物里没有 system 段'; return out; }
  /* 逐块整段命中计数（不是只查首句 —— 只留首句不算「完整」） */
  var allIn = true;
  fs2.parts.forEach(function (p) {
    var n = sys.split(p.text).length - 1;   /* 整块正文唯一命中次数 */
    out.段命中[p.id] = n;
    if (n !== 1) allIn = false;
  });
  out.五段全在 = allIn;
  /* 反向：旧 shell 卡的 [角色声音] 不该再进 system（证明走共享层、不是回退） */
  out.含旧shell卡标记 = sys.indexOf('[角色声音]') >= 0;
  /* ⚠️ 指纹**不能在页内算**：
     - `require('crypto')` 在浏览器里不存在；
     - `crypto.subtle.digest` 是**异步**的，而 FINGERPRINT 是同步函数；
     - 之前把 Node 侧的 checksum 写进来 → `ReferenceError: checksum is not defined`，
       **首轮发出前就崩了**（所幸零请求已发）。
     → 页内只做纯字符串判断，**把 system 原文回传 Node 侧**再算指纹。 */
  out.system长度 = sys.length;
  out._原文 = sys;
  return out;
};

/* 简易校验和（FNV-1a 32bit → 8 位十六进制）—— **Node 侧**执行。
   ★ 定位：不是密码学哈希，只用于「同一份 system 是否逐字相同」的快速比对。
   ★ 要密码学强度时用同页的 sha256hex。 */
function checksum(s) {
  var h = 0x811c9dc5, str = String(s), i;
  for (i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

/* ============================================================
   出站 messages 原文核验（用户要求：**校验和不能替代原文**）

   ★ 只落 SHA-256 **不足以核验** —— 别人无法据此判断注了什么。
     所以：**原文 + SHA-256 一起落**。
   ★ 但**必须先扫真实用户资料**：夹具是虚构的，若 messages 里出现
     真实用户的角色名/对话内容，说明读到了真实存档 → **停止发送**。
   ★ 凭据绝不落盘（key 只从环境变量读，不进 messages）。
   ============================================================ */

/* 真实资料泄露哨兵：命中即停，不发这一轮 */
var LEAK_GUARD = function () {
  var sys = '';
  try {
    var s = Sleepy.offlineStore.findSession(window.__sid);
    var asmb = Sleepy.promptEngine.assembleOffline({
      charId: s.charId, userId: s.userId, session: s, userInput: '(原文核查)'
    });
    asmb.messages.forEach(function (m) {
      sys += (m && m.role === 'system' ? String(m.content || '') : '') + '\n';
    });
  } catch (e) { return { ok: false, 理由: '装配抛错：' + String(e && e.message) }; }
  /* 哨兵词：来自真实存档才可能出现的东西。夹具里的 fictional 角色不触发。 */
  var sentinels = ['sk-', 'Bearer ', 'api_key', 'access_token'];
  var hit = sentinels.filter(function (w) { return sys.indexOf(w) >= 0; });
  if (hit.length) {
    return { ok: false, 理由: '疑似凭据混入出站 messages', 命中: hit };
  }
  return { ok: true, 理由: '未发现凭据字面量' };
};

/* 取本轮真实出站的 messages 原文 + SHA-256（**Node 侧算**，页内不碰 crypto） */
var sha256hex = function (s) {
  return require('crypto').createHash('sha256').update(String(s), 'utf8').digest('hex');
};
var OUTBOUND = function () {
  var s = Sleepy.offlineStore.findSession(window.__sid);
  var asmb = Sleepy.promptEngine.assembleOffline({
    charId: s.charId, userId: s.userId, session: s, userInput: '(原文核验)'
  });
  var msgs = (asmb && asmb.messages ? asmb.messages : []).map(function (m) {
    return { role: m && m.role, content: String((m && m.content) || '') };
  });
  /* 只带**角色 + 长度**：原文回 Node 侧再拼，避免页内拼大字符串 */
  return {
    条数: msgs.length,
    角色序列: msgs.map(function (m) { return m.role; }),
    各段长度: msgs.map(function (m) { return m.content.length; }),
    _原文: msgs
  };
};

/* ---------- 参数核对（用户要求：发出前核对最终请求确为批准值）----------
   ★ 为什么要查「最终 body」而不是查 store：
     环境变量 / UI 设置可能覆盖默认值，查配置层不代表最终发出的值。
     这里读**生产自己算出来的 genParams 结果**（与 bodyFor 同源），
     并顺带记录 timeoutSec（它不进 body，但影响真实等待）。
   ★ 期望值从 Node 侧传进来，**不在页内写死** —— 避免两处漂移。 */
var PARAM_CHECK = function (want) {
  var S = Sleepy;
  var cfg = S.store.get('mainApi') || {};
  var got = S.promptEngine ? null : null;
  /* 走生产同一个 genParams：api.js 里 bodyFor 用的就是它。
     这里通过一次「无副作用」的探针取实际会发出的值。 */
  var actual = null;
  try {
    var cand = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      temperature: cfg.temperature, maxTokens: cfg.maxTokens,
      contextMessages: cfg.contextMessages, stream: cfg.stream,
      timeoutSec: cfg.timeoutSec };
    actual = S.api.genParams ? S.api.genParams(cand, {}) : null;
  } catch (e) {
    return { ok: false, 理由: 'genParams 抛错：' + String(e && e.message) };
  }
  if (!actual) {
    /* api.js 未导出 genParams 时退回读配置层（并在结果里标明来源） */
    actual = { temperature: cfg.temperature, maxTokens: cfg.maxTokens,
      contextMessages: cfg.contextMessages, stream: cfg.stream,
      timeoutSec: cfg.timeoutSec };
    return { ok: '配置层', 来源: '配置层（genParams 未导出）',
      temperature: actual.temperature, max_tokens: actual.maxTokens,
      contextMessages: actual.contextMessages, stream: actual.stream,
      timeoutSec: actual.timeoutSec };
  }
  var bad = [];
  if (actual.temperature !== want.temperature) bad.push('temperature');
  if (actual.maxTokens !== want.maxTokens) bad.push('maxTokens');
  if (actual.contextMessages !== want.contextMessages) bad.push('contextMessages');
  if (!!actual.stream !== want.stream) bad.push('stream');
  return {
    ok: bad.length === 0,
    不符项: bad,
    来源: 'genParams（与最终 body 同源）',
    temperature: actual.temperature, max_tokens: actual.maxTokens,
    contextMessages: actual.contextMessages, stream: !!actual.stream,
    timeoutSec: actual.timeoutSec
  };
};

/* 页内 FINGERPRINT → Node 侧补算指纹（页内不能碰 crypto，见 FINGERPRINT 内注释） */
async function fingerprintOf(pg) {
  var fp = await pg.evaluate(FINGERPRINT);
  if (fp && typeof fp._原文 === 'string') {
    fp.system校验和 = checksum(fp._原文);
    fp.systemSHA256 = sha256hex(fp._原文);
  }
  return fp;
}

/* ============================================================
   依赖轮判定（**纯函数，导出以便零网络测试**）

   ★ 为什么要抽出来：这条规则是「失败后不发依赖轮」的核心，
     之前它内嵌在轮次循环里，**只能在真跑时验证** ——
     而真跑一次要花一次请求。抽成纯函数后，
     任何一条分支都能用桩数据**零网络**测到。
   ============================================================ */
function prevTurnTrusted(prev) {
  if (!prev) return { ok: false, why: '上一轮无记录' };
  if (prev.未发出) return { ok: false, why: '上一轮未发出' };
  if (prev.未跑) return { ok: false, why: '上一轮未跑' };
  var raw = prev.原始请求结果 || {};
  if (prev.已落地 !== true) return { ok: false, why: '上一轮未落地' };
  if (prev.最终阶段 !== 'model-returned') {
    return { ok: false, why: '上一轮非 model-returned（' + (prev.最终阶段 || '无阶段') + '）' };
  }
  if (typeof raw.len !== 'number' || raw.len <= 0) {
    return { ok: false, why: '上一轮内容为空' };
  }
  /* ★ 降级轮要拦住：上游给了内容、HTTP 200、也「落地」了，
     但正文是 parseOfflineReply 的失败标记（PARSE_FAIL_MARK/HINT），
     或者压根没解析出段落 —— **不是可用的角色回复**。
     ⚠️ 判据必须按**完整字符串**比，绝不靠长度：
        折叠区那句 PARSE_FAIL_EMPTY 正好 14 字，与降级标记（19/24 字）长度接近。
     ⚠️ 这里只做「是不是降级」的判定，**不**去判内容质量。 */
  var degraded = false;
  var out = String(prev.原始输出 == null ? '' : prev.原始输出).trim();
  if (out === '这一轮的回复格式出了点问题。') degraded = true;
  if (out === '这一轮的回复格式出了点问题，原始返回可展开查看。') degraded = true;
  if (out === '（本次没有可查看的原始内容）') degraded = true;
  if (degraded) return { ok: false, why: '上一轮是解析降级回复（不是可用角色回复）' };
  /* 段落是「真的解析出了结构」的证据。**缺失即不可信** ——
     ⚠️ 这里曾经写成「无段落 **且** 正文非空 才拦」，
        结果「两者都缺」时会被**放行** → 判据有洞（自检抓到了）。
     ★ 修正：**无段落一律拦**。有段落才谈得上「解析出了东西」。 */
  if (!prev.段落 || !prev.段落.length) {
    return { ok: false, why: '上一轮无解析段落（没有可用的结构化回复）' };
  }
  return { ok: true, why: '' };
}

/* ---------- 零网络测试用的导出 ----------
   ★ 被 `require` 时**只导出纯函数**，不发任何请求；
     直接 `node` 运行时的行为与以前完全一致。
   这让「失败后不发依赖轮」这条规则**无需真实模型即可验证**。
   ★ 2026-10-05 追加导出 FIXTURE / SETUP：
     夹具字段丢失追踪要在**零网络沙箱**里跑同一条装配链，
     若测试自己重写一份夹具，它验的就不是验收脚本实际用的那份。 */
module.exports = { prevTurnTrusted: prevTurnTrusted, APPROVED: APPROVED,
  runGroupSchedule: runGroupSchedule, hardStopKind: hardStopKind,
  requestBodyEvidence: requestBodyEvidence,
  makeSnapshotWriter: makeSnapshotWriter,
  FIXTURE: FIXTURE, SETUP: SETUP,
  /* P3 矩阵（2026-10-05 冻结）—— 导出好让零网络预检 require **同一份**，
     绝不重抄：抄一遍就会「测的矩阵」与「跑的矩阵」不是同一个东西。 */
  GROUPS: GROUPS,
  C5_JUDGE: C5_JUDGE, C5_JUDGE_ALL: C5_JUDGE_ALL, C5_JUDGE_RULE: C5_JUDGE_RULE,
  /* 页面侧函数以**文本**导出：vm 沙箱里要用同一份实现跑，不能重抄 */
  SETUP_SRC: SETUP.toString(),
  CAPTURE_SRC: CAPTURE_SRC,
  STOP_KIND_FOR_SEND: STOP_KIND_FOR_SEND,
  LEAK_GUARD_SRC: LEAK_GUARD.toString() };

/* 被 require 时到此为止：不启动浏览器、不发请求。 */
if (require.main !== module) return;

/* ============================================================
   共用调度器（**正式流程与测试都调它** —— 不是另写一套模拟循环）

   ★ 为什么抽出来：三个需求绑在一起 ——
     ① 「失败后不发依赖轮」要能被零网络测试验证；
     ② 「每组只登记一次」不能靠「两处 push 互斥」这种**未经证明的假设**；
     ③ 「持久化完成前不得发下一轮」需要把写入变成显式依赖。
   ★ 依赖注入：`send`（发一轮）、`persist`（把当前内存状态落盘）。
     正式流程传真实实现；测试传替身，**不启动浏览器、不发网络**。
   ★ 不变量（调度器自己保证，不靠调用方记得）：
     - 每个组**恰好登记一次**（`registerGroup` 只允许首次生效）；
     - 每轮**先持久化再决定下一轮**；
     - 持久化抛错 → **停止后续发送**（不吞错误）。
   ============================================================ */
function runGroupSchedule(spec) {
  var turns = spec.turns || [];
  var send = spec.send;              /* async (turnIndex, input) → turnRecord */
  var persist = spec.persist;        /* async (state, phase) → void；抛错即停止 */
  var log = spec.log || function () {};
  var stopKind = spec.stopKind || function () { return null; };
  var trust = spec.trust || prevTurnTrusted;   /* 依赖判定，测试可注入 */

  /* ★ 三个计数，含义不同、不可混用（用户 2026-10-04 要求）：
       调度次数   —— 循环走到第几轮（含未发出/未跑）
       确认发送数 —— **真的交给了请求出口**的次数（未发出不算）
       未知状态数 —— 已交给出口但结果不明（采集异常等）
     ⚠️ 「未发出」绝不能计入确认发送数 —— 那会把「没发」说成「发了」。 */
  var state = {
    轮次: [], 组已登记: false, 停机原因: null, 停止整跑: false, 终态: null,
    调度次数: 0, 确认发送数: 0, 未知状态数: 0, 持久化次数: 0,
  };

  function registerGroup(meta) {
    if (state.组已登记) return false;      /* ★ 幂等：第二次调用无效 */
    state.组已登记 = true;
    state.登记 = meta;
    return true;
  }

  /* 补齐剩余轮为「未跑」，并落盘。不依赖「进入下一轮」才触发。 */
  async function markRestUnrun(from, why) {
    for (var ri = from; ri < turns.length; ri++) {
      state.轮次.push({
        轮: ri + 1, 输入: turns[ri], 已落地: false, 未跑: true,
        未跑原因: why,
        原始请求结果: null, 归因: null, 出站messages: null,
        原始输出: null, 段落: null, 诊断: null,
      });
    }
  }

  /* ★ 终态落盘：允许比轮数多写一次。
     上一轮把「n 轮只能写 n 次」当通过条件，结果**末轮失败被漏掉** ——
     终态（停机原因/计数）是必须留存的证据，不能因为「次数对不上」而不写。 */
  async function persistPhase(phase) {
    state.当前写入阶段 = phase;
    await persist(state, phase);
    state.持久化次数++;
  }

  return (async function run() {
    for (var ti = 0; ti < turns.length; ti++) {
      state.调度次数 = ti + 1;
      /* ---- 防线①：发送前依赖检查（保留）---- */
      if (ti > 0) {
        var chk = trust(state.轮次[ti - 1]);
        if (!chk.ok) {
          log("  ⛔ 前一轮未产出可信回复（" + chk.why + "）→ **本轮不发出**");
          await markRestUnrun(ti, "依赖轮被拦截：" + chk.why);
          state.停机原因 = "依赖轮被拦截（上一轮未产出可信回复）";
          state.拦截轮 = ti + 1;
          registerGroup({ 组: spec.id, 拦截轮: ti + 1 });
          state.终态 = "依赖拦截";
          await persistPhase("终态");
          return state;
        }
      }

      /* ---- 发这一轮 ---- */
      var rec;
      try {
        rec = await send(ti, turns[ti]);
      } catch (e) {
        state.轮次.push({ 轮: ti + 1, 输入: turns[ti], 已落地: false,
          未跑: true, 未跑原因: "send 抛错：" + String(e && e.message),
          发送异常: String(e && e.message),
          原始请求结果: null, 归因: null, 出站messages: null,
          原始输出: null, 段落: null, 诊断: null });
        state.停机原因 = "send 抛错：" + String(e && e.message);
        state.停止整跑 = true; state.终态 = "send 抛错";
        registerGroup({ 组: spec.id, 发送异常: true });
        await persistPhase("终态");
        return state;
      }
      state.轮次.push(rec);
      /* ★ 确认发送数：只有「真的交给出口」才加。
         未发出（rec.未发出）**不加**；采集异常要单独计未知。 */
      if (rec.未发出) {
        state.确认发送数 += 0;
      } else {
        state.确认发送数++;
        if (rec.采集异常) state.未知状态数++;
      }

      /* ---- 持久化（每轮）---- */
      try {
        await persistPhase("轮次");
      } catch (e) {
        state.停机原因 = "持久化失败：" + String(e && e.message);
        state.停止整跑 = true; state.持久化失败 = true; state.终态 = "持久化失败";
        state.持久化错误 = { message: String(e && e.message), code: e && e.code,
          轮: ti + 1, 已发送数: state.确认发送数 };
        throw e;    /* 不吞：让调用方看到真实错误 */
      }

      /* ---- ★ 失败与停机检查：**每轮之后立即做**，含最后一轮、单轮组 ---- */
      var reason = null;
      var sk = stopKind(rec);
      if (sk === "perm") reason = "权限不可用(403)";
      else if (sk === "net") reason = "网络/超时：" + ((rec.原始请求结果 || {}).stage || "?");
      else if (sk === "link") reason = "采集关联异常（诊断 requestId 缺失或落地不匹配）";
      else if (rec.未发出) reason = "未发出：" + ((rec.未发出 || {}).why || "未知");
      else if (!trust(rec).ok) {
        /* ★ 末轮失败在这里被抓住 —— 不再依赖「还有下一轮」 */
        reason = "本轮未产出可信回复（" + trust(rec).why + "）";
      }
      if (reason) {
        state.停机原因 = reason;
        state.停止整跑 = true;
        state.终态 = reason;
        /* ★ 剩余轮补记未跑，不依赖进入下一轮 */
        if (ti + 1 < turns.length) {
          await markRestUnrun(ti + 1, "前一轮失败（" + reason + "），依赖轮不自动重试");
        }
        registerGroup({ 组: spec.id, 停机: reason, 停机轮: ti + 1 });
        await persistPhase("终态");
        return state;
      }
    }
    /* 正常跑完（全部轮都有可信回复） */
    registerGroup({ 组: spec.id, 正常跑完: true });
    state.终态 = "正常跑完";
    await persistPhase("终态");
    return state;
  })();
}
/* 整组/整跑停机的判定（正式流程与测试共用）
   ★★ 职责边界（这轮修掉的顺序 bug）：
     `hardStopKind` 只管**「立即停止整个试跑」**的硬条件；
     **超时 / 网络失败不在其中** —— 它们归「依赖轮拦截」处理
     （`prevTurnTrusted` 会在下一轮发送前拦住）。
   ⚠️ 上一版曾把 `stage==='timeout'|'network'` 从这里移除 ——
      那导致超时被降级成「只拦依赖轮、继续跑后续组」。
      **用户 2026-10-04 明确：网络/超时继续停止整跑。**
      两者不冲突：`hardStopKind` 管「立即停整跑」，
      `prevTurnTrusted` 管「发送前别发下一轮」，**两道防线都在**。
   ✔ 硬停止：403（凭据/权限）、网络/超时（线路不可用）、
     采集关联异常（数据不可信，继续跑只会污染样本）。 */
/* ============================================================
   请求体缺证判定（2026-10-05 · B）
   ------------------------------------------------------------
   ★ 问题：旁路可能**拿到了成功响应**，却**没留下请求体证据**
     （`__SEND` 被清空、采集抛错、messages 抓失败…）。
     那种轮次 `hardStopKind` 现在**判不出问题** ——
     `ok:true` + 有诊断 + 有输出 ⇒ 一切看起来正常，
     于是后续轮、后续组继续跑，产出一批**无法核验「模型收到了什么」**的样本。
     钱花了、证据没有 ⇒ 必须当采集异常停掉。

   ★ 判定口径（`requestBodyEvidence`）：
     只在「**本应有请求记录**」的轮次上生效 ——
       · `未发出` 的轮次**不走这里**（它根本没到网络，交给未发出分支）；
       · 其余轮次都应有一条 `发送瞬间请求体`。
     缺证的三种形态：
       ① 整条记录缺失（本应有却没有）
       ② 有记录但 `bodyCaptureError` 非空（采集明确失败）
       ③ 有记录但缺少本场景**必需**的 messages 证据（`messages` 为 null / 条数为 0）

   ⚠️ **不改写已有成功响应、不丢本轮输出**：
     这个函数**只回答「要不要停」**，
     不碰 `原始输出` / `段落` / `归因` / `诊断`。
     本轮该留的东西照样落盘，停的是**后续**。
   ============================================================ */
function requestBodyEvidence(t, opts) {
  opts = opts || {};
  var out = { 应有: false, 缺证: false, 原因: '', 形态: null };
  if (!t) return out;
  /* 「未发出」明确走未发出分支 —— 这里不接管 */
  if (t.未发出) { out.原因 = '未发出（不走缺证判定）'; return out; }
  out.应有 = true;
  var rec = t.发送瞬间请求体;
  if (!rec) {
    out.缺证 = true; out.形态 = '记录缺失';
    out.原因 = '本轮应有请求体记录，但没有';
    return out;
  }
  if (rec.记录写入失败) {
    out.缺证 = true; out.形态 = '记录写入失败';
    out.原因 = '请求体记录写入失败：' + rec.记录写入失败;
    return out;
  }
  if (rec.bodyCaptureError) {
    out.缺证 = true; out.形态 = '采集失败';
    out.原因 = '请求体采集失败：' + rec.bodyCaptureError;
    return out;
  }
  /* ★★ messages 证据的**严格**校验（2026-10-05 · 四）：
     「有一条 messages」不够 —— 必须**每一项**都能核验：
       · `messages` 是**数组**（不是对象/字符串/null）
       · **非空**（长度 ≥ min）
       · 每个条目是**对象**，且 `role` 与 `content` **都存在**
     为什么这么严：请求体是「模型到底收到了什么」的唯一证据。
     一条 `role` 缺失、或 `content` 为空的记录，**无法核验** ——
     它不能证明「现场信息确实送到了」。
     ⚠️ 允许的例外：多模态的 `content` 可能是**数组**（结构化），
        那种只要非空就算有效（采集侧已深脱敏，值本身可用）。 */
  var min = opts.minMessages == null ? 1 : opts.minMessages;
  var msgs = rec.messages;
  if (!Array.isArray(msgs)) {
    out.缺证 = true; out.形态 = 'messages 非数组';
    out.原因 = '请求体里的 messages 不是数组（是 ' +
      (msgs === null ? 'null' : typeof msgs) + '）';
    return out;
  }
  if (msgs.length < min) {
    out.缺证 = true; out.形态 = 'messages 条数不足';
    out.原因 = '请求体里没有可用的 messages 证据（条数 ' + msgs.length +
      ' < 必需 ' + min + '）';
    return out;
  }
  /* 逐条核验 role / content */
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      out.缺证 = true; out.形态 = 'messages 条目形状不对';
      out.原因 = 'messages[' + i + '] 不是对象';
      return out;
    }
    if (!m.role) {
      out.缺证 = true; out.形态 = 'messages 缺 role';
      out.原因 = 'messages[' + i + '] 缺 role（无法核验这条证据）';
      return out;
    }
    var c = m.content;
    var contentOk = (typeof c === 'string' && c.length > 0) ||
      (Array.isArray(c) && c.length > 0);
    if (!contentOk) {
      out.缺证 = true; out.形态 = 'messages 缺 content';
      out.原因 = 'messages[' + i + '] 的 content 为空或不可用（' +
        (c === null ? 'null' : typeof c) + '）';
      return out;
    }
  }
  out.messages条数 = msgs.length;
  return out;
}

function hardStopKind(t, opts) {
  if (!t || t.未跑) return null;
  /* 「未发出」不是硬停止 —— 它根本没到网络；由调度器的「未发出」分支处理 */
  if (t.未发出) return null;
  /* ★★ 发送记录写入失败（2026-10-05 · 与停机调度的接线点）
     旁路已把 fetch 换成 reject，所以 raw.stage 会是 network ——
     但**不能只靠那个**：`network` 也可能是真的网络故障。
     这里显式判一次：记录写不进去 ⇒ 这一轮的**发送瞬间证据永久缺失**，
     继续跑只会产出「无法核验」的样本 ⇒ 归为 link（采集异常，硬停）。
     ⚠️ 顺序必须在 network 判定**之前** —— 否则它会被 network 抢走，
        停机原因就写成「网络故障」，而真实原因是「证据没留下」。 */
  if (t.发送瞬间请求体 && t.发送瞬间请求体.记录写入失败) return 'link';
  if (t.发送记录错误 && t.发送记录错误.length) return 'link';
  var raw = t.原始请求结果 || {};
  if (raw.status === 403 || /403/.test(String(raw.error || ''))) return 'perm';
  if (raw.stage === 'network' || raw.stage === 'timeout') return 'net';
  /* ★★ 请求体缺证（B）：**成功响应也可能没有请求体证据**。
     那种轮次若放过去，后续样本全都不可核验 ⇒ 归为 link。

     ⚠️⚠️ 位置很讲究（第一版放在 network **之前**，是错的）：
       上面第 2 条「记录写入失败」必须在 network 之前 ——
       因为那里的 network 是**后果**（旁路 reject 造成的），
       真实原因是「证据没留下」，被 network 抢走就写错了原因。
       而 B 这一条不同：它是**兜底**，针对「除此之外一切正常、
       却偏偏没有请求体证据」的轮次。
       若也放在 network 之前，真实的 403 / 超时会被一律改写成
       「采集异常」—— **停机结论没错，但原因被掩盖**，
       排障时会往错的方向查。
     ⇒ 放在真实失败判定**之后**：那些轮次本来就硬停（perm/net），
       原因准确；只有「本该成功却没证据」的才归 link。 */
  if (requestBodyEvidence(t, opts).缺证) return 'link';
  if (!t.诊断 || (t.已落地 && t.诊断.requestId === undefined)) return 'link';
  return null;
}

/* ============================================================
   逐轮快照落盘（正式流程用；测试注入自己的替身）

   ★ 为什么要每轮都写：原先只在**全部跑完后**写一次文件。
     若中途崩溃/断电，已跑的轮次**一个都不剩** ——
     而那正是「已经花了钱」的证据。
   ★ 写入失败**不吞**：抛给调度器 → 它停止后续发送。
     这条很关键：落盘失败还继续发，等于「付了钱没留下证据」。
   ============================================================ */
function makeSnapshotWriter(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var n = 0;
  return async function writeSnapshot(记录集, st, meta_stop, errors) {
    n++;
    var stamp2 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var f = path.join(dir, '快照-' + 记录集.样本组 + '-' +
      ('000' + n).slice(-3) + '-' + stamp2 + '.json');
    var payload = {
      元信息: {
        快照序号: n,
        生成时间: new Date().toISOString(),
        样本组: 记录集.样本组, 名称: 记录集.名称,
        阶段: st.当前写入阶段 === '终态' ? '终态快照（该组已结束）'
          : '逐轮快照（运行中，尚未收尾）',
        写入阶段: st.当前写入阶段 || null,
        /* ★ 三个计数分列，含义不同不可混用（用户 2026-10-04 要求）：
             确认发送数 —— 真的到了请求出口（未发出不算）
             未知状态数 —— 已到达但采集异常
             调度次数   —— 循环走到第几轮 */
        确认发送数: st.确认发送数,
        未知状态数: st.未知状态数,
        调度次数: st.调度次数,
        /* 旧字段名保留兼容，但**别当成确认发送数** —— 它曾经把
           「未发出」也算进去。已在下面显式标注。 */
        _已发送数_旧字段: st.已发送数 !== undefined ? st.已发送数 : null,
        持久化次数: st.持久化次数,
        组已登记: st.组已登记,
        终态: st.终态 || null,
        停机原因: meta_stop || st.停机原因 || null,
        持久化错误: st.持久化错误 || null,
        页面报错: (errors || []).slice(0, 10)
      },
      样本: [{ 样本组: 记录集.样本组, 名称: 记录集.名称, 轮次: 记录集.轮次 || [] }]
    };
    /* 同步写 + fsync：确保「返回成功」确实意味着已落盘。
       异步 writeFile 的回调可能在进程退出时才执行。 */
    var fd = fs.openSync(f, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(payload, null, 2), null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return f;
  };
}

(async function main() {
  var browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch (e) {
    process.stdout.write('SKIP：无法启动 Edge（' + e.message + '）\n');
    process.exit(0);
  }
  var errors = [];
  /* ★ 逐轮快照写入器（每轮落盘；失败会抛 → 调度器停止后续发送） */
  var writeSnapshot = makeSnapshotWriter(path.join(OUT_DIR, "逐轮快照"));

  /* ⚠️ 每个样本组用**全新 context + 全新 page**。
     原因（实测踩到）：页面实例是缓存复用的，上一组若有未收尾的请求，
     它的 busy / pending 状态会跟着 DOM 复用进下一组，
     于是第二组起 send 按钮一直 disabled，样本全废。
     这不是模型问题，是验收脚本的会话隔离缺陷。 */
  async function newPage() {
    var c = await browser.newContext();
    var pg = await c.newPage();
    pg.on('pageerror', function (e) {
      errors.push('PAGEERROR: ' + String(e && e.message));
    });
    pg.on('console', function (m) {
      if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
    });
    await pg.goto(BASE + '?splash=0', { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('window.Sleepy && Sleepy.offlineDiag', null, { timeout: 20000 });
    await pg.waitForFunction(
      '!!document.querySelector(\'[data-page="home"].is-active\')', null, { timeout: 20000 });
    await pg.waitForTimeout(500);
    /* 凭据注入页内（只在这一页的内存里，页面关掉即失） */
    await pg.evaluate(function (cfg) {
      window.__API_BASE = cfg.base;
      window.__API_KEY = cfg.key;
      window.__API_MODEL = cfg.model;
      window.__APPROVED = cfg.approved;
      /* ★ 预算闸上限（2026-10-05）：Node 侧注入，未设 = 不启用。
         用于「只允许 N 次真实模型请求」的验收。 */
      window.__BUDGET_LIMIT = cfg.budgetLimit || null;

      /* ---------- 旁路模块装载（2026-10-05）----------
         ★ 为什么用源码注入而不是在 evaluate 里重写一遍：
           采集逻辑（脱敏 / SHA-256 / messages 保留）**必须只有一份实现** ——
           Node 侧单测要 require 同一份，页内要跑同一份。
           两处各写一遍必然漂移，而漂移的方向恰好是「测的和发的不是一个东西」。
         ★ 页内没有 require、没有同步 crypto，所以传文本 + new Function 求值。 */
      (0, eval)(cfg.captureSrc);

      /* ---------- 归因字段抓取（v2 新增 · P0 产出）----------
         ★ 为什么必须包 fetch：生产 callModel 只透传 {ok, text}，
           **丢掉了 res.data**（api.js 的 requestOnce 成功结果里 data 是完整响应体）。
           不包这一层就永远拿不到 finish_reason / usage / reasoning_content ——
           而这三项正是 8192 截断归因的唯一依据。
         ★ 只旁路记录，**不改变任何返回内容**（读 clone，原 body 透传给生产代码）。
         ★ 只包最外层网络通道，**中间的装配/判定全走生产代码**。

         ⚠️ 2026-10-05 补上「提交给 fetch 的请求体」这一侧：
           此前只记响应侧（finish_reason/usage/reasoning），
           于是**装配与发送之间没有任何快照** ——
           「存在于响应后装配快照」被误当成「客户端提交给 fetch 的内容」。
           installFetchBypass 在**调用 origFetch 之前**同步采集 init.body：
           原始 body 字符串的 SHA-256 + 脱敏后的
           model/messages/stream/max_tokens/temperature（messages 保留 role+content 原文）。
           ⚠️ 措辞口径（2026-10-05 收口统一）：这一份叫
             **「客户端提交给 fetch 的请求体」**。
             它是客户端这一侧提交的**输入**，**不声称**服务端已收到、
             更不声称模型已消费 —— 那需要响应/正文侧证据，不是这一份能给的。
           响应侧采集**原样保留**（见 __HTTP 与 rec.发送瞬间）。 */
      window.__RAW = [];
      var origFetch = window.fetch;
      /* ★ 传 knownSecrets：脱敏的**第一条腿**是「已知凭据精确匹配」。
         为什么必需：真实测试凭据（`stub-…`、自造的固定串）**未必**长得像
         sk-…／JWT，纯形状匹配会漏。实测：`stub-trace-key-not-real`
         在不传 knownSecrets 时**脱敏改动数 = 0**（漏）。
         ⚠️ 凭据只在本页内存里；传进去的是**值**，不会落盘
         （落盘的是脱敏后的记录 + sha8 指纹）。 */
      window.__SEND_ERRORS = [];
      window.fetch = window.F2BodyCapture.installFetchBypass(window, {
        knownSecrets: [window.__API_KEY].filter(Boolean),
        /* ★ 全局模型请求预算闸（2026-10-05 · 由 Node 侧注入，未设则不启用）。
           上限 1 ⇒ 自动开场 / 重试 / 候选回退 / 后台调用统统走这里，
           第 2 次起直接 reject —— 单轮验收时用来兜住「只发 1 次」。 */
        budget: window.__BUDGET_LIMIT ? { limit: window.__BUDGET_LIMIT } : null,
        onRecordError: function (why, rec) {
          /* 记录失败要**看得见**，且不能被后续轮次覆盖掉 */
          try { window.__SEND_ERRORS.push({ at: window.__SEND.length, why: why }); }
          catch (e) { /* 连这个都写不进去就只剩 reject 本身了 */ }
        }
      });
      /* 归因数组由 installFetchBypass 建（__HTTP / __SEND）。
         ⚠️ 这里**不再自己包一层** —— 旧实现与新实现并存会记两次出站，
            采集顺序也会变得无法解释（旧那层在 origFetch 之后才记 body）。 */
      void origFetch;   /* 保留引用仅为可读性：确认我们包的是真实 fetch */
      /* 观测钩子：把 requestOnce 的**原始失败结果**留下来。
         ⚠️ 只读不改：包一层记结果再原样调用，不改变任何返回内容。 */
      var orig = Sleepy.api.requestOnce;
      Sleepy.api.requestOnce = function () {
        var args = arguments;
        return orig.apply(this, args).then(function (r) {
          if (r && r.ok === false) {
            window.__RAW.push({ stage: r.stage, status: r.status, ms: r.ms,
              error: r.error, detail: String(r.detail || '').slice(0, 300) });
          } else if (r) {
            window.__RAW.push({ stage: 'ok', ms: r.ms, status: r.status,
              len: String(r.content || '').length });
          }
          return r;
        }, function (e) {
          window.__RAW.push({ stage: 'throw', error: String(e && e.message) });
          throw e;
        });
      };
    }, { base: API_BASE, key: API_KEY, model: API_MODEL, approved: APPROVED,
      captureSrc: CAPTURE_SRC, budgetLimit: BUDGET_LIMIT });
    return pg;
  }
  var page = await newPage();

  process.stdout.write('\n私聊线下 F2 · 模型效果真机验收 · ' + BASE + '\n');
  process.stdout.write('模型: ' + API_MODEL + '\n');
  process.stdout.write('端点: ' + maskUrl(API_BASE) + '\n');
  process.stdout.write('密钥: ' + maskKey(API_KEY) + '\n');
  process.stdout.write('输出预算 maxTokens: ' + MAX_TOKENS + '\n');
  process.stdout.write('批次: ' + TAG + '\n');
  process.stdout.write('★ 不注入任何 requestOnce 桩 —— 全部真实出站。\n\n');

  var results = [];
  var meta_stop = null;   /* 停机原因（若有）；未跑项如实登记 */
  var groups = GROUPS.filter(function (g) { return !ONLY || String(g.id) === String(ONLY); });

  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    process.stdout.write('—— 样本组 ' + g.id + '：' + g.key + ' ——\n');

    /* ★ 每组换全新页面 —— 见 newPage() 处的说明 */
    if (gi > 0) {
      try { await page.close(); } catch (e) { /* 已关就算了 */ }
      page = await newPage();
    }
    await page.evaluate(SETUP, { f: FIXTURE });
    await page.waitForFunction(SCENE_READY, null, { timeout: 20000 });
    await page.waitForTimeout(800);

    /* ★ 轮次逻辑已抽成 sendOneTurn（与测试共用同一份实现，见 runGroupSchedule）。
       依赖检查与三道检查都在**发出前**完成，逻辑一行没少，只是搬进了回调。 */
    var sendOneTurn = async function (ti) {
      var input = g.turns[ti];
      /* ---------- 发出前三道检查（用户要求：每次发出前都要）----------
         ① 凭据泄露哨兵：出站 messages 里出现 key 类字面量 → **停止整个试跑**
         ② 装配五段完整在位：不在位 → 本轮不发出（不浪费次数）
         ③ 参数核对：最终 body 确实是批准的那几个值（防环境变量覆盖默认值） */
      var leak = await page.evaluate(LEAK_GUARD);
      if (!leak.ok) {
        process.stdout.write(String.fromCharCode(10) + "❌ 停止整个试跑：" + leak.理由 + String.fromCharCode(10));
        var e1 = new Error("凭据泄露哨兵命中：" + leak.理由);
        e1.__stopKind = "perm"; e1.__命中 = leak.命中; throw e1;
      }
      var fp = await fingerprintOf(page);
      if (!fp.五段全在 || fp.含旧shell卡标记) {
        process.stdout.write(String.fromCharCode(10) + "❌ 停止整个试跑：装配五段未完整在位" + String.fromCharCode(10));
        var e2 = new Error("装配五段未完整在位"); e2.__stopKind = "link";
        e2.__段命中 = fp.段命中; throw e2;
      }
      var pcheck = await page.evaluate(PARAM_CHECK, {
        temperature: APPROVED.temperature,
        maxTokens: APPROVED.maxTokens,
        contextMessages: APPROVED.contextMessages,
        stream: APPROVED.stream
      });
      if (!pcheck.ok) {
        process.stdout.write(String.fromCharCode(10) + "❌ 停止整个试跑：参数与批准值不符" + String.fromCharCode(10));
        var e3 = new Error("参数与批准值不符"); e3.__stopKind = "config";
        e3.__实测 = pcheck; throw e3;
      }
      process.stdout.write("  [发出前] 哨兵通过 · 五段在位 · 参数(temp=" + pcheck.temperature +
        ",max_tokens=" + pcheck.max_tokens + ",ctx=" + pcheck.contextMessages +
        ",stream=" + pcheck.stream + ")" + String.fromCharCode(10));

      /* ⚠️ before 必须记「本轮开始时的消息数」**和**「本轮开始时的最大消息下标」，
         否则解析失败/超时轮会抓到**上一轮残留的旧消息**当成自己的输出。 */
      var before = await page.evaluate(function () {
        var s = Sleepy.offlineStore.findSession(window.__sid);
        return { n: s ? s.messages.length : 0,
          lastId: (s && s.messages.length)
            ? s.messages[s.messages.length - 1].id : null };
      });
      var sendRes = await page.evaluate(SEND, g.turns[ti]);
      if (!sendRes.sent) {
        process.stdout.write('  ⚠ 第' + (ti + 1) + '轮没发出去：' + JSON.stringify(sendRes) + '\n');
        return { 轮: ti + 1, 输入: input, 未发出: sendRes,
          原始请求结果: null, 归因: null, 出站messages: null,
          原始输出: null, 段落: null, 诊断: null };
      }
      /* 等这一轮落地：轮询消息增长 + 忙碌解除 */
      /* 轮询落地。⚠️ 超时给足（真实模型可能几十秒）——
         早期版本 40×600ms=24s 太短，会把「模型还在想」误判成「没落地」。 */
      var beforeN = before.n;   /* 供页内闭包引用 */
      /* 轮询落地。
         ⚠️ 判据必须是「**本轮新增**了 char/scene 消息」，
            不能用「消息数变多 且 不忙」——
            失败轮（超时/reject）也会解除 busy，会被误判成落地，
            然后去抓上一轮的旧消息当本轮输出。第一批组2轮3 就这么错的。
         ★ 单一可信判据是**诊断的 stage**（真实出站那次）：
           只有 model-returned 才算成功；其余都是失败，
           失败轮**不得**去取任何「输出」。 */
      var landed = false;
      var finalStage = null;
      for (var w = 0; w < 150; w++) {
        await page.waitForTimeout(1000);
        var st = await page.evaluate(function () {
          var s = Sleepy.offlineStore.findSession(window.__sid);
          var d = Sleepy.offlineDiag.snapshot();
          /* 本轮**新增**的 char/scene（只认下标 > before.n 的） */
          var fresh = null;
          var bN = window.__beforeN || 0;   /* 页内取值：Node 侧的变量进不来 */
          if (s) {
            for (var i = bN; i < s.messages.length; i++) {
              var m = s.messages[i];
              if (m && (m.role === 'char' || m.role === 'scene')) fresh = m;
            }
          }
          return {
            n: s ? s.messages.length : 0,
            stage: d ? d.stage : null,
            freshText: fresh ? (fresh.paras || []).map(function (p) {
              return p.type === 'dialogue' ? '「' + p.text + '」' : p.text;
            }).join('\n') : null,
            freshParas: fresh ? (fresh.paras || []) : null,
            freshRole: fresh ? fresh.role : null,
            busy: (function () {
              var i2 = document.querySelector('.off-input-field');
              var b2 = document.querySelector('.off-send-btn');
              return !!(i2 && i2.disabled) || !!(b2 && b2.disabled);
            })()
          };
        });
        finalStage = st.stage;
        if (st.stage === 'model-returned' && st.freshText) { landed = true; break; }
        /* 出结论且不是还在途 → 失败轮，不等 */
        if (!st.busy && st.stage && st.stage !== 'at-call-boundary') { landed = false; break; }
      }
      /* 把本轮起点传进页内，供「只取本轮新增」用 */
      await page.evaluate(function (n) { window.__beforeN = n; }, before.n);
      /* ★ 失败轮**不取任何输出**。原来是「从后往前找最后一条 char/scene」，
         失败时会抓到上一轮残留 —— 那是把不存在的东西当证据。 */
      var rec = await page.evaluate(function (ok) {
        if (!ok) return { latest: null, diag: Sleepy.offlineDiag.snapshot() };
        var s = Sleepy.offlineStore.findSession(window.__sid);
        var fresh = null;
        if (s) {
          for (var i = window.__beforeN; i < s.messages.length; i++) {
            var m = s.messages[i];
            if (m && (m.role === 'char' || m.role === 'scene')) fresh = m;
          }
        }
        return {
          latest: fresh ? { role: fresh.role,
            text: (fresh.paras || []).map(function (p) {
              return p.type === 'dialogue' ? '「' + p.text + '」' : p.text;
            }).join('\n'),
            paras: fresh.paras || [] } : null,
          diag: Sleepy.offlineDiag.snapshot()
        };
      }, landed);
      var rawres = await page.evaluate(function () {
        var r = window.__RAW || [];
        var last = r.length ? r[r.length - 1] : null;
        window.__RAW = [];
        return last;
      });
      /* ★ 归因记录（v2 新增）：取本轮对应的最后一次出站。
         fetch 旁路与 requestOnce 是同一个请求，按序对齐。 */
      var http = await page.evaluate(function () {
        var h = window.__HTTP || [];
        var last = h.length ? h[h.length - 1] : null;
        window.__HTTP = [];
        return last;
      });
      /* ★ 记录写入失败（红线①）单独取一次，**不吞**。
         这些是「这一轮的发送证据丢了」的事实，必须进轮记录。 */
      var sendErrs = await page.evaluate(function () {
        var e = window.__SEND_ERRORS || [];
        var all = e.slice();
        window.__SEND_ERRORS = [];
        return all;
      });
      /* ★ 全局请求预算读回（2026-10-05）：每次轮结束都把**累计**计数带出来。
         ⚠️ 读的是**累计值**而不是本轮增量 —— 预算本身就是全局的，
         报告里必须能看出「到目前为止一共发了几次、被拒了几次」。 */
      var budgetState = await page.evaluate(function () {
        var b = window.__BUDGET;
        if (!b) return null;
        return { limit: b.limit, used: b.used,
          allowedCount: b.allowed.length, rejectedCount: b.rejected.length,
          allowed: b.allowed.map(function (x) { return x.url; }),
          rejected: b.rejected.map(function (x) { return x.url; }) };
      });
      /* ★★ 客户端提交给 fetch 的请求体（2026-10-05）
         —— 这是「**客户端提交给 fetch 的内容**」的唯一来源。
         ⚠️ 口径（2026-10-05 收口统一）：它是**客户端这一侧提交的输入**。
           **不声称**服务端已收到，**更不声称**模型已消费 ——
           那需要响应侧 / 回复正文侧证据，不是这一份能给的。
           也不等于「模型一定注意到了场景」：那要看它写出来什么。
         ⚠️ 与上面 归因/出站messages 是**三份不同的东西**，不可互相替代：
            · 出站messages = 响应**之后**重新跑一次装配的结果（快照，可能已漂）
            · 归因        = 响应**之后**的 HTTP 元数据
            · 请求体      = **调用 origFetch 之前**的 init.body（唯一时序正确的一份）
         ⚠️ 失败轮也可能有请求体记录（发出去了但没落地）→ 照样取，
            绝不因为「这轮失败」就丢掉请求体证据。 */
      var sendRec = await page.evaluate(function () {
        var s = window.__SEND || [];
        var last = s.length ? s[s.length - 1] : null;
        window.__SEND = [];
        return last;
      });
      /* ★ 出站 messages **原文 + SHA-256**（用户要求：校验和不能替代原文）。
         原文在 Node 侧算 SHA-256（页内没有 crypto，也没有 require）。 */
      var ob = await page.evaluate(OUTBOUND);
      var obText = (ob.角色序列 || []).map(function (r, i) {
        return r + '\n' + String((ob._原文[i] || {}).content || '');
      }).join('\n---\n');
      var 出站 = {
        条数: ob.条数,
        角色序列: ob.角色序列,
        各段长度: ob.各段长度,
        总长度: obText.length,
        SHA256: sha256hex(obText),
        原文: ob._原文
      };
      delete ob._原文;
      /* ★ 三层对齐用的对照口径（用户 2026-10-05）：
         「发送瞬间」与「响应后装配快照」必须能并排比。
         记录 body 哈希与装配快照哈希的口径差，别让读者以为它们本该相等。 */
      var 装配messages原文 = obText;
      var 对齐 = {
        说明: '发送瞬间请求体（init.body）与响应后装配快照是**两层**，本字段只登记口径，不下结论',
        发送瞬间bodySHA256: sendRec ? sendRec.bodySHA256 : null,
        响应后装配SHA256: sha256hex(装配messages原文),
        两者相等: sendRec && sendRec.bodySHA256
          ? (sendRec.bodySHA256 === sha256hex(装配messages原文)) : null,
        口径差说明: '两个哈希的对象不同：前者是 init.body 整段 JSON 串，' +
          '后者是「role\\ncontent」按 --- 拼接的装配快照。**不相等是正常的**，' +
          '不能用它判断「模型没收到场景」—— 那种判断必须看 messages 原文逐字段比。'
      };
      return {
        轮: ti + 1,
        输入: g.turns[ti],
        已落地: landed,
        最终阶段: finalStage,
        原始请求结果: rawres,
        归因: http,
        发送瞬间请求体: sendRec,
        /* ★ 红线①的证据：记录写不进去 = 这一轮的请求体证据丢了。
           数组（可能多条），空数组 = 没有丢。 */
        发送记录错误: sendErrs,
        /* ★ 全局模型请求预算的累计状态（null = 未启用预算闸） */
        请求预算: budgetState,
        /* ★ 与停机调度的接线：把这个 stopKind 交给 runGroupSchedule 的
           stopKind 参数（见调用处），记录写入失败即判「采集异常」硬停。 */
        发送停机建议: sendRec ? STOP_KIND_FOR_SEND(sendRec) : null,
        三层对齐: 对齐,
        出站messages: 出站,
        原始输出: rec.latest ? rec.latest.text : null,
        段落: rec.latest ? rec.latest.paras : null,
        诊断: rec.diag,
        /* ★ 判分表骨架：**只落空表 + 原文引用位，绝不预填结论**。
           评分由人工/后续批次按方案 §5 填写，每档必须引用触发原文。 */
        判分: (g.judge === 'C5')
          /* ★★ G5 专用：**五档互斥判分表**（2026-10-05 冻结）。
             为什么不用通用 0/1：F1/F2 的核心是「叙述方式」而非「内容对错」，
             二值判分会把「未触发」折算成「通过」——
             那等于用「模型没犯错」冒充「规则被验证过」。
             ⚠️ 落盘时**全为 null**（未判分），由人工按 C5_JUDGE_RULE 填。
             ⚠️ 「未触发」与「合规」是两个**独立**字段，不许合并成一个布尔。 */
          ? {
            档位: null,                 /* C5_JUDGE 五档之一；未判分 = null */
            F1违规: null, F2违规: null, 合规: null, 证据不足: null, 未触发: null,
            证据引用: '',               /* 必须摘出命中的原文句子 */
            主判: null,                 /* 本轮主判 'F1' 或 'F2' */
            主观标记: null,             /* 原文里有没有 猜/觉得/不知道/大概 类标记 */
            是否判M: null,              /* ★ 本组恒为 false —— M1-M4 归 G6 */
            不重复判定: ''              /* 同句若兼涉记忆/未来断言，标「归 G6」 */
          }
          : { D1行为正确性: null, D2人物保真: null, D3现场连续: null,
            D4user主体性: null, D5格式稳定: null, D6重复说教模板化: null,
            证据引用: '', 是否否决: null, 否决项: '' }
      };
    };
    /* ★★ 交给共用调度器 —— 它保证「每组恰好登记一次」与「先持久化再下一轮」。
       旧的写法在两处 results.push（L706 拦截分支 + L905 循环后），
       而普通 break 只跳出**内层轮次循环**，外层 push **照常执行** →
       **同一组会被登记两次**。这是本轮修掉的真 bug。 */
    /* ★ 字段名统一为「样本组」—— 与 results 的所有消费者一致。
       之前这里叫「组」，而下游读 g.样本组 → 读到 undefined。 */
    var 记录集 = { 样本组: g.id, 名称: g.key, 目标: g.goal, 观察点: g.watch, 轮次: null,
      /* P3 矩阵溯源（2026-10-05）：案例号 / 规则 / 判分制式 /
         **修复后重跑标记** —— 明确哪些轮次的 P1 旧样本**不得**混入本次统计。 */
      案例: g.case || null,
      规则: g.rule || null,
      判分制式: g.judge === 'C5' ? 'C5五档' : '通用D1-D6',
      修复后重跑轮: g.rerunAfterFix ? g.rerunAfterFix.轮 : null,
      修复后重跑原因: g.rerunAfterFix ? g.rerunAfterFix.原因 : null,
      修复后重跑是否额外追加: g.rerunAfterFix
        ? (g.rerunAfterFix.是否额外追加 === false ? false : null) : null,
      本组数据来源: g.rerunAfterFix
        ? (g.rerunAfterFix.旧样本处置
          + '（本轮第 ' + g.rerunAfterFix.轮 + ' 轮**已在矩阵 17 轮内**，'
          + '**不额外追加**为第 18/19 轮。）')
        : '本组为 P3 新增，无历史同构样本。'
    };
    var 调度态 = await runGroupSchedule({
      id: g.id,
      /* ★ 只跑前 N 轮（MAX_TURNS 未设 = 全跑，保持既有行为） */
      turns: MAX_TURNS > 0 ? g.turns.slice(0, MAX_TURNS) : g.turns,
      send: sendOneTurn,
      persist: async function (st) {
        记录集.轮次 = st.轮次;
        /* ★ 每轮都落盘（含失败轮与未跑轮）。
           写入失败必须让调度器知道 —— 它会停止后续发送，不吞错误。 */
        await writeSnapshot(记录集, st, meta_stop, errors);
      },
      log: function (m) { process.stdout.write(m + String.fromCharCode(10)); },
      stopKind: hardStopKind
    });
    记录集.轮次 = 调度态.轮次;
    results.push(记录集);            /* ★ 唯一一次登记（调度器已保证幂等） */
    if (调度态.停机原因) {
      meta_stop = meta_stop || { 停机原因: 调度态.停机原因, 组: g.id };
      process.stdout.write(String.fromCharCode(10) +
        "❌ 停止整个试跑：" + 调度态.停机原因 + String.fromCharCode(10));
      break;                          /* ★ 不再启动后续组 */
    }
  }
  /* ---------- 收尾：写样本文件（凭据一律脱敏） ---------- */
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  var file = path.join(OUT_DIR, TAG + '-' + API_MODEL.replace(/[^\w.-]/g, '_') + '-' + stamp + '.json');

  var meta = {
    批次: TAG,
    生成时间: new Date().toISOString(),
    /* ★★ P3 溯源与计数口径（2026-10-05 冻结）—— 落进样本文件，
       使「哪些轮次是修复后重跑」**可事后核验**，不靠报告人自觉。 */
    P3矩阵: {
      组数: GROUPS.length,
      各组轮数: GROUPS.map(function (x) {
        return { 组: x.id, 案例: x.case, 轮数: x.turns.length,
          判分制式: x.judge === 'C5' ? 'C5五档' : '通用D1-D6',
          修复后重跑轮: x.rerunAfterFix ? x.rerunAfterFix.轮 : null };
      }),
      正式轮次合计: GROUPS.reduce(function (a, x) { return a + x.turns.length; }, 0),
      会话约定: '每个 GROUPS 条目 = 一个独立会话（独立 context + 独立 page）',
      /* ★★ 预算口径 A（2026-10-05 用户确认）：**总上限 18 次** */
      预算口径: {
        口径: 'A',
        总上限: 18,
        正式矩阵轮次: GROUPS.reduce(function (a, x) { return a + x.turns.length; }, 0),
        健康探测: 1,
        构成: '17 轮正式矩阵 + 1 次健康探测 = 18',
        额外追加: 0,
        说明: 'G4/G7 的第 1 轮**已包含在 17 轮内**，执行时用修复后版本重新发送，'
          + '**不额外追加**为第 18/19 轮。'
      },
      修复后重跑说明: 'G4/G7 的第 1 轮在 P1 跑过，但那是**修复前**样本'
        + '（出站 body 里 user 输入重复两次）。'
        + 'P1 修复前旧样本：排除，不计入 P3 统计；'
        + '本轮修复后重新发送样本：计入 P3 正式统计。',
      旧样本排除口径: '★ docs/样本-G4轮1-2026-10-05/ 下的两份（P1 修复前）'
        + '与 docs/样本-G4轮1-修复复验-2026-10-05/ 下的一份（单轮链路验证）'
        + '**一律不得并入 P3 正式统计**，仅保留为历史证据。'
    },
    C5五档判分: {
      档位集: C5_JUDGE_ALL,
      各档规则: C5_JUDGE_RULE,
      强制口径: '「未触发」**不等于**「规则通过」——'
        + '前者是没考到，后者是考过且合规。报告须分列：'
        + '触发轮数 / 违规轮数 / 合规轮数 / 证据不足轮数 / 未触发轮数。',
      禁判项: 'G5 **不判 M1/M2/M3/M4**（归 G6）；'
        + '同句兼涉记忆/未来断言与猜测事实化 ⇒ 归 G6，G5 标「不重复判定」。'
    },
    模型: API_MODEL,
    端点: maskUrl(API_BASE),
    密钥: maskKey(API_KEY),
    温度: APPROVED.temperature,
    maxTokens: APPROVED.maxTokens,
    contextMessages: APPROVED.contextMessages,
    行为文本版本: (await page.evaluate(function () {
      return (Sleepy.behaviorText && Sleepy.behaviorText.VERSION) || '(见诊断 version 字段)';
    })),
    角色资料版本: '验收夹具 __f2eff_role__（虚构，不读真实存档）',
    场景前置: FIXTURE.scene,
    已发生的前置动作: FIXTURE.preActions,
    在场NPC: FIXTURE.npc,
    样本数: results.reduce(function (a, g) { return a + g.轮次.length; }, 0),
    页面报错: errors.slice(0, 10)
  };
  /* ★ 停机与未跑如实登记（用户要求：「不必凑满 4 次」） */
  meta.停机 = meta_stop || '未停机，跑完全部计划轮次';
  var 未跑 = [];
  results.forEach(function (g) {
    g.轮次.forEach(function (t) {
      if (t.未跑) 未跑.push({ 组: g.样本组, 轮: t.轮, 原因: t.未跑原因 });
    });
  });
  var 未开的组 = groups.filter(function (g) {
    return !results.some(function (r) { return r.样本组 === g.id; });
  }).map(function (g) { return { 组: g.id, 名称: g.key }; });
  meta.未跑项 = { 组内未跑: 未跑, 整组未开: 未开的组 };
  /* 实际发出的 HTTP 请求数（用户批准上限 4 次实际请求，不是 4 次函数调用） */
  /* ★ 三个计数分开记，含义不同、不可互相替代（用户 2026-10-04 要求）：
       确认发送数 —— 轮次里**没有**「未发出」标记的（真的到了请求出口）
       未知状态数 —— 到了出口但采集异常（诊断缺失/无 requestId）→ **不记为零请求**
       未发出数   —— 明确没发出去的（send 返回未发出）
     ⚠️ 旧口径用「有原始请求结果」判定，会把「已发出但采集异常」误算成没发。 */
  meta.请求计数 = (function () {
    var sent = 0, unknown = 0, notSent = 0, unrun = 0;
    results.forEach(function (g) {
      g.轮次.forEach(function (t) {
        if (t.未跑) { unrun++; return; }
        if (t.未发出) { notSent++; return; }
        sent++;
        if (!t.诊断 || (t.已落地 && t.诊断.requestId === undefined)) unknown++;
      });
    });
    return { 确认发送数: sent, 未知状态数: unknown, 未发出数: notSent, 未跑轮数: unrun,
             口径说明: '确认发送数=到达请求出口；未知状态数=已到达但采集异常（不记为零请求）；未发出数=明确没发出' };
  })();
  /* 兼容旧字段名：它现在等于「确认发送数」，不再是「有原始结果的数量」 */
  meta.实际HTTP请求数 = meta.请求计数.确认发送数;
  /* ---------- 装配指纹落盘（v2 · 0 付费，本地装配不发请求）----------
     这是「这批样本由哪个装配版本产出」的唯一事后可核验凭据。
     旧样本正因缺它而无法自证注了什么。 */
  try {
    meta.装配指纹 = await fingerprintOf(page);
    /* ★ 删掉回传的 system 原文：① 体积大 ② 与逐轮的「出站messages 原文」重复
       （那里才是按轮保存原文的地方）③ 指纹只需可核对，不必重复存全文。 */
    if (meta.装配指纹) delete meta.装配指纹._原文;
  } catch (e) {
    meta.装配指纹 = { 备注: '指纹采集抛错：' + String(e && e.message) };
  }
  if (meta.装配指纹 && meta.装配指纹.五段全在 === false) {
    process.stdout.write('\n❌ 装配指纹异常：五段未全部唯一命中 → ' +
      JSON.stringify(meta.装配指纹.段命中) + '\n');
  }
  if (meta.装配指纹 && meta.装配指纹.含旧shell卡标记) {
    process.stdout.write('\n❌ system 里出现了旧 shell 卡标记 [角色声音] → ' +
      '装配走的是回退路径，不是共享层。\n');
  }
  /* ---------- 口径统计（v3：各指标**分别记录**，不做错误等式）----------
     ⚠️ v2 写的「K1 - K3 = 解析失败轮 + 空内容轮 + 超时轮 + 网络失败轮」是**错的**，
        已按用户指出删除：
          · **超时 / 网络失败根本没有 HTTP 响应**，它们**不属于 K1**；
            K1 的定义是「HTTP 200」，一个超时请求永远不会进 K1。
          · 所以那个等式右侧含超时/网络失败，左侧却是 K1 的差集 → 恒不成立。
        v3 的做法：**每个指标独立记数，互不相加、不做减法**。
        失败分类是**另一个维度**（按原因分组），与 K1/K2/K3 **不是同一套划分**，
        一个轮次可以同时是「K1 有返回」和「非空但解析失败」——
        所以**绝不能**把失败分类的项数拿来对 K1−K3 求和。 */
  var 口径 = {
    总请求数: 0,
    K1_有返回: 0, K2_有内容: 0, K3_可评: 0,
    降级提示数: 0,
    字段缺失: { finish_reason: 0, usage: 0, reasoning_content: 0 },
    失败分类: { 权限不可用_403: 0, 超时: 0, 预算截断: 0, 非空但解析失败: 0,
      网络失败: 0, 其他: 0 }
  };
  results.forEach(function (g) {
    g.轮次.forEach(function (t) {
      口径.总请求数++;
      var raw = t.原始请求结果 || {};
      var stage = (t.诊断 || {}).stage;
      var h = t.归因 || {};
      /* K1 有返回：HTTP 层成功。⚠️ 超时/网络失败**不计入**（无 HTTP 响应）。 */
      if (raw.stage === 'ok' || raw.status === 200) 口径.K1_有返回++;
      /* K2 有内容：**上游原始长度**（raw.len），绝不用下游展示文本 */
      if (typeof raw.len === 'number' && raw.len > 0) 口径.K2_有内容++;
      /* ⚠️ 降级判据是**中性标记**的**完整字符串** ——
         有两个变体（page-offline.js:55 PARSE_FAIL_MARK /
         :56 PARSE_FAIL_HINT），两个都要排除。
         ⚠️⚠️ 绝不靠长度判断：折叠区那句 PARSE_FAIL_EMPTY（:57）正好 14 字，
            与降级标记（19 / 24 字）长度接近 —— 凭长度必错（此坑连栽三次）。 */
      var out = String(t.原始输出 || '').trim();
      var degraded = (out === '这一轮的回复格式出了点问题。') ||
        (out === '这一轮的回复格式出了点问题，原始返回可展开查看。');
      /* K3 可评：唯一进入判分的口径 */
      var k3 = (stage === 'model-returned' && t.已落地 &&
        typeof raw.len === 'number' && raw.len > 0 && !degraded);
      if (k3) 口径.K3_可评++;
      if ((t.诊断 || {}).requestOk === false) 口径.降级提示数++;
      /* 归因字段缺失统计：⚠️ 记「接口未提供」，**绝不填 0**。
         字段真的没有 ≠ 字段值为 0，两者在归因上结论相反。 */
      if (h.finish_reason === null || h.finish_reason === undefined) 口径.字段缺失.finish_reason++;
      if (!h.usage) 口径.字段缺失.usage++;
      if (!h.has_reasoning) 口径.字段缺失.reasoning_content++;
      /* 失败分类 */
      if (raw.status === 403 || /403/.test(String(raw.error || ''))) {
        口径.失败分类.权限不可用_403++;
      } else if (raw.stage === 'timeout' || /超时/.test(String(raw.error || ''))) {
        口径.失败分类.超时++;
      } else if (raw.stage === 'network') {
        口径.失败分类.网络失败++;
      } else if (raw.len === 0 && raw.stage === 'ok') {
        口径.失败分类.预算截断++;   /* HTTP 200 但 content 空 = 预算被思考吃满 */
      } else if (t.已落地 && /^\s*\{/.test(String(t.原始输出 || ''))) {
        口径.失败分类.非空但解析失败++;
      }
    });
  });
  /* ★ 只保留**包含关系**自检（这是定义，不是对账等式）：
       K3 ⊆ K2 ⊆ K1 ⊆ 总请求数
     ⚠️ 失败分类**不在**这条链里 —— 超时/网络失败根本没有 HTTP 响应，
        天然不在 K1 内；「非空但解析失败」则同时属于 K1 和失败分类。
        两个维度独立，禁止相减对账。 */
  if (!(口径.K3_可评 <= 口径.K2_有内容 &&
        口径.K2_有内容 <= 口径.K1_有返回 &&
        口径.K1_有返回 <= 口径.总请求数)) {
    throw new Error('口径包含关系被违反（K3≤K2≤K1≤总）：' + JSON.stringify(口径));
  }
  meta.口径 = 口径;
  /* ---------- 逐请求汇总（用户要求的回交字段）----------
     缺失字段一律 null，**绝不推定为 0**。 */
  meta.逐请求 = [];
  results.forEach(function (g) {
    g.轮次.forEach(function (t) {
      var h = t.归因 || {};
      var u = h.usage || null;
      meta.逐请求.push({
        组: g.样本组, 轮: t.轮, 输入: t.输入,
        未跑: !!t.未跑,
        requestId: t.诊断 ? (t.诊断.requestId === undefined ? null : t.诊断.requestId) : null,
        seq: t.诊断 ? (t.诊断.seq === undefined ? null : t.诊断.seq) : null,
        诊断stage: t.诊断 ? (t.诊断.stage || null) : null,
        诊断modules: t.诊断 ? (t.诊断.modules || null) : null,
        http状态: h.status === undefined ? null : h.status,
        耗时ms: h.ms === undefined ? (t.原始请求结果 && t.原始请求结果.ms !== undefined
          ? t.原始请求结果.ms : null) : h.ms,
        finish_reason: h.finish_reason === undefined ? null : h.finish_reason,
        usage_prompt_tokens: u && u.prompt_tokens === undefined ? null : (u ? u.prompt_tokens : null),
        usage_completion_tokens: u && u.completion_tokens === undefined ? null : (u ? u.completion_tokens : null),
        usage_total_tokens: u && u.total_tokens === undefined ? null : (u ? u.total_tokens : null),
        推理字段是否提供: h.has_reasoning === undefined ? null : h.has_reasoning,
        推理长度: h.reasoning_len === undefined ? null : h.reasoning_len,
        上游content长度: h.content_len === undefined ? null : h.content_len,
        本轮采到正文长度: t.原始输出 ? t.原始输出.length : null,
        解析结果: t.段落 ? ('成功，' + t.段落.length + ' 段') :
          (t.已落地 ? '已落地但无段落' : '未落地'),
        落地: !!t.已落地,
        出站messages条数: t.出站messages ? t.出站messages.条数 : null,
        出站messages_SHA256: t.出站messages ? t.出站messages.SHA256 : null
      });
    });
  });
  /* ★ 强制结论口径：P1 只有 4 轮，**样本量远不足**。
     无论这 4 轮人物表现多好，**都不许得出人物效果结论**。 */
  meta.结论口径 = '样本不足，不下人物效果结论。' +
    '本批次仅验证「请求完整返回 / 采集器不拿错消息 / 判分规则可落地」，' +
    '不构成对 B/P/L/N/S2 效果的任何结论。';
  meta.口径说明 = {
    K1_有返回: 'HTTP 200（超时/网络失败无响应，不计入）',
    K2_有内容: '上游原始 content 长度 > 0（raw.len）',
    K3_可评: 'stage=model-returned 且已落地 且 K2 且 未降级 —— 只有这些进判分',
    字段缺失: '「接口未提供」的计数；缺失一律记 null，绝不填 0',
    失败分类: '**独立维度**，按原因分组；与 K1/K2/K3 不是同一套划分，**不相加、不对账**'
  };
  process.stdout.write('\n--- 口径（各指标独立记录，不做对账等式）---\n');
  ['总请求数', 'K1_有返回', 'K2_有内容', 'K3_可评', '降级提示数'].forEach(function (k) {
    process.stdout.write('  ' + k + ' = ' + 口径[k] + '\n');
  });
  process.stdout.write('  包含关系 K3≤K2≤K1≤总 = ' +
    (口径.K3_可评 <= 口径.K2_有内容 && 口径.K2_有内容 <= 口径.K1_有返回 &&
     口径.K1_有返回 <= 口径.总请求数) + '\n');
  process.stdout.write('  归因字段缺失 = ' + JSON.stringify(口径.字段缺失) + '\n');
  process.stdout.write('  失败分类（独立维度，不与 K1-K3 对账）= ' +
    JSON.stringify(口径.失败分类) + '\n');
  process.stdout.write('★ ' + meta.结论口径 + '\n');

  fs.writeFileSync(file, JSON.stringify({ 元信息: meta, 样本: results }, null, 2), 'utf8');

  process.stdout.write('\n样本已落盘: ' + file + '\n');
  if (errors.length) {
    process.stdout.write('⚠ 页面报错 ' + errors.length + ' 条（前 3 条）：\n' +
      errors.slice(0, 3).map(function (e) { return '   ' + e; }).join('\n') + '\n');
  }
  process.stdout.write('\n⚠️ 这些是**单次输出**，不是普遍结论。下一步要做的是问题分类，' +
    '不是下判断。\n');

  await browser.close();
})().catch(function (e) {
  process.stdout.write('脚本异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
