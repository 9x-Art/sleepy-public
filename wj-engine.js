/* ============================================================
   wj-engine.js — 帷境 · 生成链与状态机
   依赖：wj-data.js（数据层，0 API）、wj-prompt.js（装配与解析）、
         api.js（真机走 Sleepy.api.runChat）
   被依赖：page-wj-read.js / page-wj-work.js / page-wj-foyer.js

   方案附录点名的四块缺口之一在这里补上第一块：
   **生成状态机**（排队/生成中/暂停/取消/失败/重试/幂等）。

   ★ 三条硬规矩：
   1. **已生成正文不丢**：失败只把章节标成 failed 并记 error；
      别的章节一个字不动。重试只重写失败/未写的目标章。
   2. **幂等**：同一章并发只允许一个在跑（running 表 + token）；
      取消后迟到的响应按 stale 丢弃，绝不出现重复章节或重复落库。
   3. **transport 可注入**：真机走 Sleepy.api；冒烟桩喂假文本
      （api.js 在桩里 fetch 直接 reject，注入点是给无头测试开的）。

   段落 id 全部出自 wj-data.anchorId（不可变）；局部重写走
   wj.rewritePara —— 只换 text、留修订，id 不动。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var wj = function () { return Sleepy.wj; };

  /* 正在跑的章节：chapterId -> { token }。
     token 是幂等闸：取消/重开以后，旧响应回来一比对就知道该扔。 */
  var running = {};

  function isStale(chapterId, token) {
    var r = running[chapterId];
    return !r || r.token !== token;
  }

  /* ----------------------- 真机 transport ----------------------- */
  /* 非流式（整章一次拿到才好切段落）；候选失败自动轮换由 runChat 负责。 */
  function apiTransport(messages, ov) {
    /* 副API分配（2026-10-26）：帷境的模型调用统一挂 feature:'wjcurtain'，
       设置→副API 勾了「帷境」就只轮询副API，没勾走主链（api.js 口径）。
       outline / 写章 / 段落重写三个调用点都从这里过 —— 一处收口。 */
    var o = ov || { maxTokens: 4000 };
    o.feature = 'wjcurtain';
    return new Promise(function (resolve, reject) {
      var h = Sleepy.api.runChat(messages, {
        onDone: function (cand, text) { resolve(text); },
        onFail: function (list, lastErr) {
          reject(new Error((lastErr && lastErr.error) || '模型没有返回'));
        }
      }, false, o);
      if (!h) reject(new Error('还没有可用的模型连接，去 设置 → 模型连接 填 API'));
    });
  }

  function transport(opts) {
    /* 按调用注入优先（无头测试用它做隔离 —— 三个并发断言各自喂各的），
       其次是全局注入点，真机走 Sleepy.api。 */
    return (opts && opts.transport) || Sleepy.wjEngine._transport || apiTransport;
  }

  /* ------------------------- 故事规划 -------------------------
     只允许在**零章**时调用 —— 章节计划是一次性的骨架，
     已有章节后重跑会跟既有正文打架。 */
  function planChapters(workId, opts) {
    var w = wj().get(workId);
    if (!w) return Promise.reject(new Error('剧本不存在'));
    if ((w.chapters || []).length) {
      return Promise.reject(new Error('已经有章节了，不再重复规划'));
    }
    return transport(opts)(Sleepy.wjPrompt.buildOutline(w), { maxTokens: 1200 })
      .then(function (raw) {
        var parsed = Sleepy.wjPrompt.parseOutline(raw);
        if (!parsed.ok) throw new Error('章节计划没有解析成功，可以重试');
        wj().mutate(workId, function (x) {
          parsed.chapters.forEach(function (c) {
            x.chapters = x.chapters || [];
            x.chapters.push({
              id: wj().uid('ch'),
              seq: x.chapters.length + 1,
              title: c.title,
              brief: c.brief,
              status: 'planned',
              paras: [],
              directorNote: ''
            });
          });
          return x;
        });
        return parsed.chapters.length;
      });
  }

  /* ------------------------- 章节生成 ------------------------- */
  function runChapter(workId, chapterId, opts) {
    return new Promise(function (resolve, reject) {
      var w = wj().get(workId);
      var ch = w && wj().findChapter(w, chapterId);
      if (!w || !ch) { reject(new Error('章节不存在')); return; }
      if (running[chapterId]) { reject(new Error('这一章正在生成')); return; }

      var token = wj().uid('gen');
      running[chapterId] = { token: token };
      wj().mutate(workId, function (x) {
        var c = wj().findChapter(x, chapterId);
        if (c) { c.status = 'generating'; c.error = ''; }
        /* 作品级状态：有正文在推进就是连载中（草稿/暂停被覆盖是预期的） */
        if (x.status === 'draft' || x.status === 'paused' || x.status === 'failed') {
          x.status = 'serializing';
        }
        return x;
      });

      var messages;
      try {
        /* 上一章选过的岔路在这里消费掉（用完即清，只影响下一章） */
        var branch = w.nextBranch && w.nextBranch.label ? w.nextBranch.label : '';
        messages = Sleepy.wjPrompt.buildChapter(wj().get(workId),
          wj().findChapter(wj().get(workId), chapterId), { branchNote: branch });
      } catch (e) {
        delete running[chapterId];
        wj().mutate(workId, function (x) {
          var c = wj().findChapter(x, chapterId);
          if (c) { c.status = 'failed'; c.error = e.message; }
          return x;
        });
        reject(e);
        return;
      }
      if (branch) {
        wj().mutate(workId, function (x) { x.nextBranch = null; return x; });
      }

      transport(opts)(messages, { maxTokens: 4000 }).then(function (raw) {
        if (isStale(chapterId, token)) { resolve({ ok: false, stale: true }); return; }
        delete running[chapterId];

        var parsed = Sleepy.wjPrompt.parseChapter(raw);
        if (!parsed.ok) {
          fail(workId, chapterId, '正文没有解析成功，可以重试');
          resolve({ ok: false, error: '正文没有解析成功' });
          return;
        }
        wj().mutate(workId, function (x) {
          var c = wj().findChapter(x, chapterId);
          if (!c) return x;
          c.paras = parsed.paras.map(function (p, i) {
            return {
              id: wj().anchorId(c.seq),     /* 不可变锚点，一次生成终身不变 */
              no: i + 1,
              kind: p.kind,
              text: p.text,
              genState: 'done',
              revisions: []
            };
          });
          c.choices = parsed.choices;
          c.status = 'ready';
          c.error = '';
          /* 第一份稳定版本：这一章第一次写完时留档（方案 §5.4 version） */
          x.versions = x.versions || [];
          var has = x.versions.some(function (v) { return v.chapterId === chapterId; });
          if (!has) {
            x.versions.push({
              id: wj().uid('ver'), chapterId: chapterId,
              label: '《' + c.title + '》初稿',
              paras: c.paras.length, createdAt: wj().nowISO()
            });
          }
          if (x.status === 'draft' || x.status === 'paused' || x.status === 'failed') {
            x.status = 'serializing';
          }
          return x;
        });
        resolve({ ok: true, paras: parsed.paras.length, choices: parsed.choices.length });
      })['catch'](function (err) {
        if (isStale(chapterId, token)) { resolve({ ok: false, stale: true }); return; }
        delete running[chapterId];
        fail(workId, chapterId, (err && err.message) || '生成失败');
        reject(err);
      });
    });
  }

  function fail(workId, chapterId, msg) {
    /* 失败是**一等状态**（红线 9）：只标记这一章，别章正文分毫不动 */
    wj().mutate(workId, function (x) {
      var c = wj().findChapter(x, chapterId);
      if (c) { c.status = 'failed'; c.error = msg; }
      var anyReady = (x.chapters || []).some(function (k) { return k.status === 'ready'; });
      if (!anyReady) x.status = 'failed';
      return x;
    });
  }

  /* 取消：立刻回到 planned；迟到的响应按 stale 丢弃。 */
  function cancelChapter(workId, chapterId) {
    delete running[chapterId];
    wj().mutate(workId, function (x) {
      var c = wj().findChapter(x, chapterId);
      if (c && c.status === 'generating') {
        var hadText = (c.paras || []).length > 0;
        c.status = hadText ? 'ready' : 'planned';
        c.error = '';
      }
      return x;
    });
    return true;
  }

  /* ------------------------- 局部重写 ------------------------- */
  function rewritePara(workId, chapterId, paraId, note, opts) {
    var w = wj().get(workId);
    var ch = w && wj().findChapter(w, chapterId);
    var para = null;
    if (ch) (ch.paras || []).forEach(function (p) { if (p.id === paraId) para = p; });
    if (!para) return Promise.reject(new Error('找不到这一段'));

    /* 同一段并发只允许一次 */
    if (para.genState === 'rewriting') return Promise.reject(new Error('这一段正在重写'));

    wj().mutate(workId, function (x) {
      var c = wj().findChapter(x, chapterId);
      if (c) (c.paras || []).forEach(function (p) {
        if (p.id === paraId) p.genState = 'rewriting';
      });
      return x;
    });

    var messages;
    try {
      messages = Sleepy.wjPrompt.buildRewrite(
        wj().get(workId), wj().findChapter(wj().get(workId), chapterId), para, note);
    } catch (e) {
      restore(workId, chapterId, paraId);
      return Promise.reject(e);
    }

    return transport(opts)(messages, { maxTokens: 1200 }).then(function (raw) {
      var text = String(raw || '').trim()
        .replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
      if (!text) throw new Error('重写没有返回内容');
      wj().rewritePara(workId, chapterId, paraId, text);   /* 只换 text，id 不动 */
      return text;
    })['catch'](function (err) {
      restore(workId, chapterId, paraId);
      throw err;
    });
  }

  function restore(workId, chapterId, paraId) {
    wj().mutate(workId, function (x) {
      var c = wj().findChapter(x, chapterId);
      if (c) (c.paras || []).forEach(function (p) {
        if (p.id === paraId && p.genState === 'rewriting') p.genState = 'done';
      });
      return x;
    });
  }

  /* ------------------------- 岔路与进度 ------------------------- */

  /* 记录一次章末选择：真实数据（branches tab 读它），
     并把选择交给下一章的生成（nextBranch，用完即清）。 */
  function chooseBranch(workId, chapterId, choice) {
    var w = wj().get(workId);
    var ch = w && wj().findChapter(w, chapterId);
    if (!w || !ch) return false;
    var last = (ch.paras || []).length
      ? ch.paras[ch.paras.length - 1].id : null;
    wj().mutate(workId, function (x) {
      x.branches = x.branches || [];
      x.branches.push({
        id: wj().uid('br'),
        fromChapterId: chapterId,
        fromAnchorId: last,
        label: choice.label,
        hint: choice.hint || '',
        chosenAt: wj().nowISO()
      });
      x.nextBranch = { label: choice.label, hint: choice.hint || '' };
      return x;
    });
    return true;
  }

  /* 已读位置：reader 滚动时回调这里。percent 按「读到的锚点 / 全书段落」算。 */
  function saveProgress(workId, chapterId, anchorId) {
    var w = wj().get(workId);
    if (!w) return;
    var total = 0, before = 0, seen = false;
    (w.chapters || []).forEach(function (c) {
      var n = (c.paras || []).filter(function (p) { return p.kind !== 'scene_break'; }).length;
      if (c.id === chapterId) {
        seen = true;
        var idx = -1;
        (c.paras || []).forEach(function (p, i) {
          if (p.id === anchorId) idx = i;
        });
        before += idx >= 0 ? idx + 1 : n;
      } else if (!seen) {
        before += n;
      }
      total += n;
    });
    wj().mutate(workId, function (x) {
      x.progress = {
        chapterId: chapterId, anchorId: anchorId,
        percent: total ? Math.round(before / total * 100) : 0
      };
      return x;
    });
  }

  /* 暂停连载 = 取消所有在跑的章节 + 作品转 paused。恢复由「继续写」自然完成。 */
  function pauseWork(workId) {
    var w = wj().get(workId);
    if (!w) return;
    (w.chapters || []).forEach(function (c) {
      if (c.status === 'generating') cancelChapter(workId, c.id);
    });
    wj().mutate(workId, function (x) {
      if (x.status === 'serializing' || x.status === 'failed') x.status = 'paused';
      return x;
    });
    return true;
  }

  function isGenerating(chapterId) { return !!running[chapterId]; }

  /* ---------------------------- 出口 ---------------------------- */

  Sleepy.wjEngine = {
    /* 测试注入点：冒烟桩设 _transport = function(messages, ov) → Promise<text> */
    _transport: null,
    planChapters: planChapters,
    runChapter: runChapter,
    cancelChapter: cancelChapter,
    rewritePara: rewritePara,
    chooseBranch: chooseBranch,
    saveProgress: saveProgress,
    pauseWork: pauseWork,
    isGenerating: isGenerating
  };

})(window);
