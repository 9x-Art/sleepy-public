# 方案 · APK 主动消息（路线 A：WorkManager 本地定时评估）v1

日期：2026-10-26 · 状态：**设计稿，待 APK 壳细节确认后施工**
前置结论：App 内的主动消息引擎已完整（见下「已有机制」），A 只解决**关页/杀进程后**的通知。

---

## 一、已有机制（不用重做）

`proactiveEngine`（评估器 + 闸门）已在，四道闸全在本地：

| 闸 | 默认值 | 出处 |
|----|--------|------|
| 免打扰时段 | 23:00 ~ 08:00 | 对话设置→主动消息安排 |
| 每天上限 | 2 次 | 同上 |
| 冷却 | 120 分钟 | 同上 |
| 暂缓（defer） | 90 分钟 | 同上 |

评估触发时机（现状）：回到聊天列表时 / 每轮回复之后 / 对话设置里手动「现在评估一次」。
→ **没有常驻定时器**（全库唯一真定时器是 moments-ai 待回复 tick），关页即停。

## 二、路线 A 的形状

**WorkManager 周期任务（16 分钟粒度是系统下限）周期唤醒 → 拉起一次性评估 → 有话就发系统通知。**

```
┌ APK 壳（原生）────────────────────────────┐
│ WorkManager periodic ≈15~30min            │
│   └→ Worker: 唤醒/offscreen WebView       │
│       载入 index.html?tick=proactive      │
│       └→ JS 跑 proactiveEngine 评估       │
│           ├ 没话 → 结束（零成本）          │
│           └ 有话 → bridge 通知 → 系统通知  │
└───────────────────────────────────────────┘
```

关键点：
1. **评估逻辑零复制**：壳只负责「唤醒 + 通知」，该不该说话、说什么，全走现有
   `proactiveEngine` 的评估与四道闸 —— 壳不懂业务。
2. **离线兜底不评估**：评估要调模型（出网）。Worker 拉起时先探网络，没网直接
   结束等下一轮；失败也静默（不弹错误通知骚扰人）。
3. **通知点开=进对话**：通知 contentIntent 载入 App 并直跳对应会话
   （URL 带 `?chat=<chatId>` 或壳内路由）。
4. **免打扰时段在原生层再挡一道**：23:00~08:00 期间 Worker 拉起后直接结束，
   连 WebView 都不用起（省电）；这个时段值从 localStorage 读一次缓存进壳。

## 三、JS 侧需要的缝（小，一次做完）

- `?tick=proactive` 启动参数：splash 完成后**不进桌面动画**，静默跑
  `proactiveEngine.evaluateAll({ source: 'apk-tick' })`，跑完把结果交给 bridge。
- JS bridge 约定（壳注入 `Sleepy.nativeNotify`）：
  `Sleepy.nativeNotify({ chatId, title, body })` —— 壳负责转系统通知；
  没有这个 bridge（普通浏览器/PWA）时 tick 模式什么也不发，行为同今天。
- 评估结果仍照常落库（主动消息消息体进对话），通知只是「敲门」。

## 四、壳侧施工清单（用户自己打 APK 时要做的）

1. `AndroidManifest`：POST_NOTIFICATIONS 权限（13+ 运行时申请一次）。
2. WorkManager 依赖 + 周期 Worker（15~30 分钟；别 <15，系统会强制归一）。
3. Worker 内：读缓存免打扰时段 → 建 offscreen WebView（或 headless
   `WebView.evaluateController`）载入本地 index.html + tick 参数 →
   注入 JS bridge → 等 evaluate 结果（超时 ~60s 放弃）。
4. 电池优化白名单引导页（小米/华为/OPPO 需要用户手动放「无限制」，给一个
   一次性的引导说明页，别默认弹）。

## 五、明确不做的

- 不做云端推送（路线 B）—— 用户已拍板后续再说。
- 不做「评估跑在原生」—— 业务逻辑留在 JS，壳保持薄。
- 不在 tick 模式里做任何 UI 渲染（offscreen，用户无感）。

## 六、验收口径（预写）

- 杀进程后等一个周期：有候选 → 系统通知出现，点开直跳对话，消息已在对话里。
- 免打扰时段：不发通知、不拉 WebView（看 logcat Worker 秒退）。
- 断网：Worker 拉起后静默退出，无错误通知。
- 每天上限/冷却照常生效（连打两次 tick 只出一条）。
