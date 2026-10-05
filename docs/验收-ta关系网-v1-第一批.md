# 验收 · ta 关系网 v1（第一批，只读）· 2026-10-02

依据《Sleepy · ta 关系网 v1 · 第一批只读施工单》§5 回报要求，逐条回交。

**三闸结论：`check.js` 全绿 / `smoke.js` 全绿（含 12 条关系网断言）/ 无头 Edge 20 项 20 通过。**

---

## 1. 修改文件、行号与原文锚点

### 新增

| 文件 | 行数 | 内容 |
|---|---|---|
| `ta-network.js` | 517 | 只读 selector。入口 `Sleepy.taNetwork.build({charId,userId,sbId})`（:195）→ `{ok,why,sbId,center,nodes,edges,visibility,updatedAt}` |
| `page-ta-network.js` | 478 | 注册页 `ta-network`（:112），图视图 + 列表视图 |
| `scripts/browser-ta-network-test.js` | — | 无头 Edge 验收，20 项（N1–N13） |

`ta-network.js` 关键锚点：

- `:62` `LABEL_NONE = '关系未注明'`；`:64` `LABEL_SOURCES = ['link.relation','charRel','']`；`:67` `PAIR_TEXT = {known:'认识', met:'见过但不熟', unknown:'不认识'}`；`:70` `GRAPH_MAX = 8`
- `:128` `npcPassesKnownBy(npc, centerId, centerRoot)`
- `:139` `pairOf`（charRel 三态）/ `:150` `linkOf`（link，**必带 sbId**）/ `:158` `linkPerms`（可见性六开关）
- `:174` `impactPersonsOf`（复用 `taImpact.activeNow`，只出 id 不带正文）
- `:195` `build`；`:205` `visibility.knownByGate = 'center-root'`；`:330` knownBy 闸调用点；`:346` `visibility.dropped`
- `:452` `labelOf` / `:459` `timeNoteOf` / `:471` `visibilityNoteOf` / `:487` `stampText`
- `:496` 导出面

`page-ta-network.js` 关键锚点：

- `:56-57` 几何常量（`R_INNER=82 / R_OUTER=132 / R_NODE=24 / R_HIT=29 / R_CENTER=30`，上方 `:44-54` 有推导注释）
- `:196` `layoutOf`（确定性环形布局，有边者内环最多 6、其余外环，超 `GRAPH_MAX` 如实标注「其余在列表」）
- `:322` 节点组（带 `is-center` 标记）/ `:350` 透明命中圆
- `:359` `renderDetail` / `:438` 列表行（可点行走 `tan-row-btn`）

### 修改

| 文件 | 行号 | 原文锚点 |
|---|---|---|
| `index.html` | `:252` `ta-impact.js` → **`:260` `ta-network.js`** → `:261` `page-ta.js` → **`:266` `page-ta-network.js`** | `:255-259` 新注释写明「它是人物节点集合的唯一出口」；`:264` 写明必须排在 `page-ta.js` 之后（`ctx.open` 运行时解析） |
| `page-ta.js` | `:26-27` 头注释改口径；`:82` `var TN = Sleepy.taNetwork`；`:160` `latestVisibleMoment` 委托；`:711` `netRes = TN.build(...)`；`:718-719` tag 只从 selector 取；`:727` 「关系网 →」入口 | `:711` 起 04 改读 `netRes.nodes` |
| `style.css` | `:14277` 起 `.tan-*` 块（`:14281` `.tan-seg .iol-seg-btn` 令牌化覆盖、`:14348` `button.tan-row` UA 重置） | 块首注释写明两条硬约束（无文档级横向滚动 / 不遮字 / 颜色只走主题令牌） |
| `sw.js` | `:210` `var CACHE = 'sleepy-v148'`；`:16` v148 更新日志 | — |
| `scripts/smoke.js` | `:11554` 起新段落（`:11577` `fireClick` / `:11593` `mkNetWorld`）；桩 `addEventListener` 改为**只记录不分发** | — |

**零改动确认**：`core.js` / `store.js` / `ta-life.js` / `ta-impact.js` / `page-island.js` / `page-switch.js` / `LAYOUT_VERSION` 全部未动。

---

## 2. selector 的节点/边规则与权限过滤证据

**节点三个来源（各自只走既有唯一口径）**

| 来源 | 出口 | 过滤 |
|---|---|---|
| 当前身份（我） | 岛名册 `activeUserOnIsland` 语义 | **不在本岛名册就没有 user 节点**，不是错误（`user=null` 时后续全部判空） |
| 岛内正式角色 | `core.charsOfSandbox` | **只收 main**（皮套不进）；排除中心自己 |
| 岛内 NPC | `core.npcsOfRoom(sb)`（全仓唯一 NPC 出口） | + `knownBy` 显示闸 |

**边只有两种来源，NPC 零边**：`link`（char×user，需 `relation` 非空）+ `charRel`（char×char，三态 known/met 才有边，unknown 无）。

冒烟证据：

```
✓ selector：中心 = 当前角色；未落岛 / 无角色 / 别岛身份各有其 why  → {"中心":"netgpj38·甲","节点":2,"边":0}
✓ selector：只收 main 正式角色（皮套不进）；NPC 走 npcsOfRoom 正式口径、别岛不串  → {"user":1,"char":1,"npc":1}
✓ selector：无依据 → 关系未注明；labelSource 只在闭集内，绝不补默认关系词  → {"未注明":"关系未注明","闭集":"3 项","默认词":0}
```

静态护栏（剥掉注释后扫源码，两个新脚本合计命中 0）：

```
✓ 关系网：静态护栏 —— 两个新增脚本 0 写入 / 0 模型 / 0 网络 / 不读草稿键  → {"护栏":2,"违禁命中":0,"顺序":"net < ta < page-net"}
```

禁词：`store.set(` / `fetch(` / `XMLHttpRequest` / `streamChat` / `api.chat` / `api.embed` / `taNpcDrafts` / `canCharSee`。
反向断言（必须有）：`M.canSee(` 与 `activeNow(` 出现（证明权限判断走的是既有出口，不是自己另判）。

---

## 3. 首页 04 与关系网同源证据

`page-ta.js:711` 只调一次 `TN.build(...)`，`netNodes` 直接来自 `netRes.nodes`；`:718-719` 的 tag 也只从 `netRes.center` 取（**不再自己 `findLink` 兜一遍**——那正是要消灭的第二套拼法）。

```
✓ ta 首页 04：节点集合与关系网 selector 完全同源（含 knownBy 过滤与人数）  → {"selector节点":3,"首页一致":true}
```

无头 Edge 侧同样验过（N12）：首页 04 里每个节点名都能在关系网页找到，被 knownBy 挡掉的 NPC 在两处**都不出现**，`N 人` 计数与 selector 一致。

---

## 4. NPC 空/缺失 knownBy 的实际判定结果与注释位置

`ta-network.js:126-136`：

```js
/* NPC 显示闸：见文件头「fail 方向和注入侧刻意相反」。
   返回 true = 可以进节点集合。 */
function npcPassesKnownBy(npc, centerId, centerRoot) {
  if (!npc || !npc.id) return false;
  if (!has(npc, 'knownBy')) return true;                    /* 缺字段 → fail open */
  var kb = npc.knownBy;
  if (!Array.isArray(kb) || !kb.length) return true;        /* 空 / 非数组 → fail open */
  if (centerId && kb.indexOf(centerId) >= 0) return true;
  if (centerRoot && kb.indexOf(centerRoot) >= 0) return true;
  return false;                                             /* 有值但不含中心 → fail closed */
}
```

**判定结果**：`knownBy` 缺失 → 显示；空数组 / 非数组 → 显示；有值且含中心角色（**自身 id 或 root**，P4）→ 显示；有值但不含 → 不显示并计入 `visibility.dropped`（只计数，**永不上屏**）。

```
✓ selector：NPC knownBy 三态（缺字段/空数组 fail-open；含别人 fail-closed）  → {"显示":4,"挡掉":1,"口径":"center-root"}
```

⚠️ **刻意与注入侧相反，别被后人「统一」**：`page-switch.js:544-546` 的 `compileIslandKB` 是 **fail closed**。关系网是**显示层**——老 NPC 突然从首页消失才是异常，所以这里必须 fail open。两处注释都写明了这一点。

被挡掉的 NPC 名**不泄漏到任何出口**：无头 Edge N8b 在列表视图里逐字搜过，`JSON.stringify(build(...))` 里也没有。

---

## 5. link 当前岛读取与可见性字段处理证据

`linkOf`（`:147-155`）**强制显式传 `sbId`**，并写明理由（`core.js:1072-1076 / 1094-1097`：同一对 char×user 在两间房里各有一条，不传就串档）。返回的是 `core.findLink` 的深拷贝，只读。

`linkPerms`（`:157-168`）**照 `core.js:1176-1184` 的原文逐个带出，不自己另判**：`cognition` / `barrier` / `iHideChar` / `iHideFromChar` / `charHidesMe` / `charHidesFromMe`。页面侧 `visibilityNoteOf`（`:471`）用闭集文案（`COG_TEXT`）翻译 `cognition`，未知值原样透传，不编语义。

```
✓ selector：link 必须按当前岛读（不串档）+ 四可见性字段原样带出  → {"甲":"甲岛的关系","乙":"乙岛的关系","四开关":"ok","空relation无边":true}
```

「空 relation 无边」这条同时验了 `hasLinkWithUser === true` 仍成立——记录存在但没写关系词时，**节点不画边、但中心卡如实说「已建立联系」**，不把「没写」说成「没关系」。

---

## 6. charRel 三态、NPC 无边的测试结果

```
✓ selector：charRel 三态（known/met 有边、unknown 无边）+ NPC 一条边都没有  → {"known":"认识","met":"见过但不熟","unknown":0,"NPC边":0}
```

`unknown` 边数 **0**（P2 决策：unknown 不画）；三态文案直接用 `PAIR_TEXT` 原文，不改成别的措辞。

---

## 7. 草稿排除、近况权限、空态、切岛结果

**草稿**（双向断言）：

```
✓ selector：taNpcDrafts 里 draft / confirmed 都不进节点（反向断言）  → {"草稿未进":true,"正式入库后进":true}
```

draft 和 confirmed **都不进**（confirmed 也仍是草稿，没落正式表）；`core.upsertChar` 正式入库后才出现。静态护栏另外证明本文件**一次都没读** `taNpcDrafts` 键。

**近况权限**（`latestVisibleMoment`，`:107-122`）：只看 TA 本人发的（`maskId` 跳过）、`status !== 'deleted'`、**走 `momentsTab.canSee(m, userId)`**。

```
✓ selector：近况走 canSee（user 视角）—— 私密 / 被屏蔽的内容不进结果  → {"公开":"net4tdec公开近况","泄露":0,"屏蔽后为空":true}
```

三条都验了：`privacy='self'` 不进、`exclude-me` 不进、马甲发的（`maskId`）不进；朋友权限 `iHideChar` 后结果为空。

**空态**：`build` 的 `why` 区分 `no-island` / `no-char` / 别岛身份三种；`user=null`（这座岛还没定我是谁）不崩、不报 `[Sleepy]` 错误（无头 Edge N11 实测）。页面在 `nodes` 为空时显示 `tan-note` 空态文案，不画空图。

**切岛**：`sbId` 变化时中心、名册、NPC、link 全部按新岛重取，**不串档**（上面 §5 的甲乙双岛断言）；NPC 也按岛隔离（`npcsOfRoom(sb)`）。

**零写入**：

```
✓ 关系网页：图 / 列表消费同一 selector 结果；打开与切视图都不写 store  → {"图节点":4,"列表节点":3,"边":1,"写入":0}
```

无头 Edge N9 另外验了 localStorage **一字未动**。

---

## 8. check / smoke / 四主题 / 横向溢出 / 触控检查结果

```
node scripts/check.js  → 全绿（48 个 page-*.js 全部已加载 / 80 个 script 引用都存在 / CSS 括号 3932:3932）
node scripts/smoke.js  → 全绿（80 个脚本加载正常，核心 API 走查通过 + 12 条关系网断言）
node scripts/browser-ta-network-test.js → 全部 20 项通过
```

无头 Edge 明细：

```
✓ N1  nav.open(ta-network) 打开、默认图视图、无 [Sleepy] 报错
✓ N1b 分段控件是「关系图 / 列表」两个
✓ N2  图上节点数 = 中心 1 + selector 前 N（3）
✓ N2b 皮套没进图
✓ N3  节点名字限制在圆内、标签不越界、文字两两不遮挡、边中点无重复文案
✓ N4  节点透明命中区 ≥44×44px
✓ N5  无文档级横向溢出，SVG 不超出容器
✓ N6  点中心节点 → 详情显示「中心角色」与关系出处
✓ N6b 点环上节点 → 详情换成该节点
✓ N7  点连线 → 关系原文 / 数据出处 / 建立时间 + 修改时间不可知
✓ N8  列表视图渲染全部 selector 节点与边（名字不截断）
✓ N8b 列表不泄露被 knownBy 挡掉的 NPC
✓ N8c 列表不泄露 privacy=self 的私密近况
✓ N8e 可点行 button 已抹掉 UA 盒子
✓ N9  打开关系网 + 切视图：localStorage 一字未动
✓ N10 四主题：节点 / 文字 / 连线 / 标签都可辨识
✓ N11 未选身份（user=null）不崩、不报 [Sleepy] 错误
✓ N12 首页 04 节点与关系网 selector 同源
✓ N13 331px 窄屏：无横向溢出、触控仍 ≥44、文字仍在圆内
```

截图落 `preview/phone-test/`：`tan-graph.png` / `tan-list.png` / `tan-ta04.png` /
`tan-theme-{grape,night,peach,sea}.png` / `tan-narrow-331.png`。
（grape 与默认主题同色，故 `tan-graph.png` 与 `tan-theme-grape.png` md5 相同，非漏拍。）

### 无头 Edge 层抓出、桩层完全测不到的 4 个真缺陷（已修）

1. **触控尺寸差一点点不够**：331px 手机上页面左右各 22px 内边距 → SVG 只剩 287px，`k≈0.797`；`R_HIT=27` 时命中直径 **43.0px** → 改 `R_HIT=29`（46.2px），推导写进注释。
2. **名字戳出圆**：`clip()` 截断长度**没算省略号**。10.5px 字体下一个中文字 ≈10.7 单位，环上圆直径 48 → 最多 4 字（含「…」）→ 截断位 3；中心圆 60 → 截断位 4。
3. **边中点文案与节点标签叠字**：v1 是星形拓扑，边的 `label` 与远端节点的 `label` **出自同一条记录**，竖直边两处只差 4 个单位 → **整段删掉中点 `<text>`**；加回 N3 反向断言 `edgeText === 0` 防回潮。
4. **`div` 改 `button` 忘重置**：列表行被 UA 套上边框底色 → `button.tan-row{border:0;background:transparent;font-family:inherit;color:inherit;text-align:left}` + N8e 断言计算样式。

另修两处**只在桩层能抓到**的：

- `page-ta.js:718` 悬空 `link` 引用（重写 04 后遗留，`'use strict'` 下会抛）。
- `ta-network.js:306` **`user === null` 崩溃**（冒烟第 2 条抓到）：角色循环无条件读 `user.id`，未选身份的岛一打开就 TypeError。

---

## 9. 未实现项（如实列出）

按施工单 §4 非目标，本批**刻意不做**：

1. **不改数据模型**：`links` 仍无 `updatedAt`（P1 决定如实显示「建立于」+「关系文本的修改时间不可知」，**不碰 `core.js` 写路径**）。
2. **NPC 关系**：NPC 与任何人都没有关系记录 → 只有节点，**一条边都没有**，标签一律「关系未注明」。
3. **不补默认关系词**：`labelSource` 只在 `['link.relation','charRel','']` 闭集内，没有依据就留空。
4. **不引第三方布局库**：手写 SVG + 确定性环形布局（不用 d3 / 力导向）。
5. **不做**：拖拽、持久化布局、搜索、编辑关系、时间轴。
6. **图视图节点上限** `GRAPH_MAX = 8`，超出部分**只在列表视图**，页面上如实标注「其余在列表」，不静默丢。
7. **无头桩过 ≠ 真机可看**：本批只跑到无头 Edge（331 / 414 两档）。**真机（用户手机）验收未做**，按项目约定**未提交、未部署**。
