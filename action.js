/* ============================================================
   action.js — 最小动作协议（第二轮施工单第三批，0 模型、0 网络、0 定时器）

   为什么要有这一层：勘察结论是「全库没有执行器」——
   写路径各自为政（手机 delta / ta 提案接受 / 帷境定史），
   每一处自己决定「什么算成功」，于是**没有一处能回答「这个动作到底成没成」**。
   本层先把「一次动作」登记成一条带 status 的记录，再去做，再把结果写回。

   ─── 形状（store key: `actionRequests`，scoped，进 core.js 删房名单）───
   { id, sandboxId, kind, target, params, requestKey,
     source:{type,id}, status:'pending'|'ok'|'failed'|'cancelled',
     attempt, createdAt, updatedAt, receiptAt, resultRef, error }

   ─── 本轮只接一种动作 ────────────────────────────────────
   kind = 'calendar.create_event'，执行时调 Sleepy.calendar.requestCreateEvent。
   别的 kind 一律拒 —— 协议先窄着用，等真有第二个动作再开。

   ─── 六条硬规矩（都写在对应位置，别改）────────────────────
   1. **status:'ok' 只能在真实 eventId 拿到之后写**（runRequest 第 ⑤ 步）。
      之前一律 pending ——「准备完成 ≠ 已经做了」。
   2. **不用模型返回的 id 当回执**：resultRef 只能是 `requestCreateEvent`
      返回的 `eventId`（由 calendar.addEvent 生成）。
   3. **失败不伪装成功**：失败写 status:'failed' + error，并留失败 receipt。
   4. **同一个 requestKey 不重复建**：命中已有 ok 记录就直接返回那一条（dup）。
   5. **本轮不实现自动 retry、不实现后台定时器** —— attempt 只做记录，
      重跑必须**显式**再调一次 runRequest（且复用原 requestKey）。
   6. **`completed` 不是执行成功的同义词**：日历事件的 status 是产品状态，
      跟这条 action 的 status 是两件事，不互相推导。

   依赖：store.js、core.js、calendar.js（排在 calendar.js 之后）
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;

  function core() { return Sleepy.core; }
  function cal() { return Sleepy.calendar; }

  var KEY = 'actionRequests';

  /* 本轮只开这一个。将来加动作**必须**同时在这里登记 + 在 runRequest 里接，
     别让 kind 变成自由字符串。 */
  var KINDS = ['calendar.create_event'];
  var STATUSES = ['pending', 'ok', 'failed', 'cancelled'];

  function arr(v) { return Array.isArray(v) ? v : []; }
  function now() { return Date.now(); }

  function newId() {
    return 'act' + now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function all() {
    var list = store.get(KEY);
    return Array.isArray(list) ? list : [];
  }

  function saveAll(list) { store.set(KEY, list); return list; }

  /* 当前房的记录（跟 core.scoped 同口径） */
  function inScope() {
    var sid = core() ? core().scopeId() : null;
    return all().filter(function (r) {
      if (!r) return false;
      return sid ? r.sandboxId === sid : true;
    });
  }

  function getRequest(id) {
    var list = all();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  function findByRequestKey(requestKey) {
    if (!requestKey) return null;
    var sid = core() ? core().scopeId() : null;
    var hit = null;
    all().forEach(function (r) {
      if (!r || r.requestKey !== requestKey) return;
      if (sid && r.sandboxId !== sid) return;
      hit = r;
    });
    return hit;
  }

  function patch(id, fields) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || list[i].id !== id) continue;
      Object.keys(fields || {}).forEach(function (k) { list[i][k] = fields[k]; });
      list[i].updatedAt = now();
      saveAll(list);
      return list[i];
    }
    return null;
  }

  /* ---------------------------- 创建 ---------------------------- */

  /* createRequest(input) —— 只登记，不做。
     input: { kind, params, requestKey?, source?, target? }
     ⚠️ 幂等只认 requestKey **且** 只看已经有结果（ok）的那条；
        pending / failed 的旧记录不算「已经做过」，重跑是允许的（复用原 key）。 */
  function createRequest(input) {
    var inp = input || {};
    if (KINDS.indexOf(inp.kind) < 0) {
      return { ok: false, error: { code: 'bad-kind', message: '本轮只支持 ' + KINDS.join(' / ') } };
    }
    var sid = core() ? core().scopeId() : null;
    if (!sid) return { ok: false, error: { code: 'no-sandbox', message: '还没进任何一间房' } };

    var key = inp.requestKey || '';
    if (key) {
      var done = findByRequestKey(key);
      if (done && done.status === 'ok') {
        return { ok: true, request: done, dup: true, eventId: done.resultRef };
      }
    }

    var rec = {
      id: newId(),
      kind: inp.kind,
      target: inp.target || { type: 'calendar', sandboxId: sid },
      params: inp.params || {},
      requestKey: key,
      source: inp.source || { type: 'ui', id: 'user' },
      status: 'pending',
      attempt: 0,
      createdAt: now(),
      updatedAt: now(),
      receiptAt: null,
      resultRef: null,
      error: null
    };
    if (core()) core().tagScope(rec);
    var list = all();
    list.push(rec);
    saveAll(list);
    return { ok: true, request: rec, dup: false };
  }

  /* ---------------------------- 执行 ---------------------------- */

  /* runRequest(id, options) —— 顺序写死，不许跳步：
       ① 取记录（必须是 pending / failed，cancelled 与已 ok 的不重跑）
       ② attempt + 1
       ③ 调 calendar.requestCreateEvent（**唯一的写入口**）
       ④ 失败 → recordFailure，返回结构化失败
       ⑤ 拿到**真实 eventId** 之后才 recordSuccess
     本轮不自动 retry：要重跑就显式再调一次，requestKey 不变就不会建两条。 */
  function runRequest(id, options) {
    var opt = options || {};
    var r = getRequest(id);
    if (!r) return { ok: false, error: { code: 'no-request', message: '没有这条动作请求' } };
    if (r.status === 'cancelled') {
      return { ok: false, error: { code: 'cancelled', message: '这条已经取消了' } };
    }
    if (r.status === 'ok') {
      return { ok: true, request: r, dup: true, eventId: r.resultRef };
    }

    var c = cal();
    if (!c || !c.requestCreateEvent) {
      recordFailure(id, { code: 'no-executor', message: '日历模块不可用' });
      return { ok: false, error: { code: 'no-executor', message: '日历模块不可用' } };
    }

    /* ② attempt：只做记录，不触发自动重试 */
    var step = patch(id, { attempt: (r.attempt || 0) + 1, status: 'pending' });
    if (!step) return { ok: false, error: { code: 'no-request', message: '没有这条动作请求' } };

    /* ③ 唯一写入口。allowConflict 由调用方（UI 已经问过用户）传进来 */
    var res = c.requestCreateEvent(r.params, {
      requestId: r.id,
      requestKey: r.requestKey || ('actkey:' + r.id),
      allowConflict: !!opt.allowConflict
    });

    /* ④ 失败：写失败回执，绝不留下任何「成功」痕迹 */
    if (!res || !res.ok) {
      var err = (res && res.error) || { code: 'unknown', message: '动作失败' };
      var fr = recordFailure(id, err);
      return {
        ok: false, request: fr, error: err,
        conflict: (res && res.conflict) || null,
        needConfirm: !!(res && res.needConfirm)
      };
    }

    /* ⑤ 真的拿到了 eventId 才算成功 */
    var okr = recordSuccess(id, { eventId: res.eventId });
    return {
      ok: true, request: okr, eventId: res.eventId,
      dup: !!res.dup,
      receipt: (okr && okr.receipt) || null
    };
  }

  /* 成功回执。**resultRef 只能是真实的 eventId** ——
     模型报的 id、payload 里自带的 id 一律不认（第二条红线）。 */
  function recordSuccess(id, result) {
    var res = result || {};
    var eventId = res.eventId || '';
    if (!eventId) {
      return recordFailure(id, { code: 'no-result', message: '没有真实结果可以记' });
    }
    var at = now();
    return patch(id, {
      status: 'ok',
      resultRef: eventId,
      receiptAt: at,
      error: null,
      receipt: {
        type: 'action_ok',
        kind: 'calendar_event_created',
        at: at,
        ref: eventId
      }
    });
  }

  /* 失败回执：保留失败记录，**不静默吞掉**（施工单 §9） */
  function recordFailure(id, error) {
    var err = error || { code: 'unknown', message: '动作失败' };
    var at = now();
    return patch(id, {
      status: 'failed',
      error: { code: err.code || 'unknown', message: err.message || '动作失败' },
      receiptAt: at,
      receipt: {
        type: 'action_failed',
        at: at,
        errorCode: err.code || 'unknown'
      }
    });
  }

  function cancelRequest(id, why) {
    return patch(id, {
      status: 'cancelled',
      error: { code: 'cancelled', message: why || '取消了' },
      receiptAt: now(),
      receipt: { type: 'action_cancelled', at: now(), errorCode: 'cancelled' }
    });
  }

  /* ---------------------------- 导出 ---------------------------- */
  Sleepy.action = {
    KEY: KEY,
    KINDS: KINDS,
    STATUSES: STATUSES,
    all: all,
    inScope: inScope,
    getRequest: getRequest,
    findByRequestKey: findByRequestKey,
    createRequest: createRequest,
    runRequest: runRequest,
    recordSuccess: recordSuccess,
    recordFailure: recordFailure,
    cancelRequest: cancelRequest
  };

})(window);
