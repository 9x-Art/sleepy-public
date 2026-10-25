/* ============================================================
   ta-relations.js — 活人系统 · L1 关系人账户表（2026-10-25，自 SullyOS
   relationshipAccounts/relationshipFeed 移植）

   TA 认识的第三人的第一方持久关系网。用户填骨架（name/relation/bond/note），
   系统养近况（currentState / openThreads / learned / lastMentioned）。

   ─── 三条铁律（SullyOS 原文照抄，一条不能松）─────────────────
   1. note：用户手写确立事实，系统推进**永不覆盖**；
   2. learned：TA 对此人的「印象」——注入时强制「未必属实」措辞兜底，
      就算模型写歪了也升不成既定事实；
   3. 生命周期：进了表的人持久存在，系统只许更新 currentState / 开关
      openThread / 记 lastMentioned / 累积 learned，**严禁默默换人**。

   ─── 生长口径（v1 用户定稿：自治生长，不走提案）──────────────
   · advance()：喂最近对话 → 提及检测（全名精确匹配，自动记 lastMentioned）
     + LLM 养一个账户的近况（fire-and-forget，节流：同账户 3 天内不重复喂、
     每轮最多 1 个账户）。LLM 失败静默，绝不阻塞主链路。
   · openThread 只在素材里确实有卡壳/和好的事时开，带 tone(good|bad)；
     时过境迁由推进自动了结，不凭空制造。
   · 本层读写不碰 LLM（LLM 由 page-chat 注入 caller）；纯函数可单测。

   ─── sleepy 纪律 ─────────────────────────────────────────
   · 键登记：store.js DEFAULTS + core.js cleanupSandbox（都已登记）；
   · 写入 core.tagScope 盖岛章 + 全量数组 set；读取 core.scoped；
   · refCharId 归 root（rootIdOf，皮套与大号共享同一段关系网）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var core = Sleepy.core;
  var store = Sleepy.store;

  var KEY = 'taRelations';
  /** 一个角色的关系网建议骨架数量上限（SullyOS 原口径：3~6 个够，别贪多） */
  var SOFT_LIMIT = 6;
  /** 同账户近况推进节流：3 天内不重复喂 */
  var NEAR_STATE_GAP_MS = 3 * 86400000;
  var OPEN_THREAD_MAX = 3;

  function arr() {
    var list = store.get(KEY);
    return Array.isArray(list) ? list : [];
  }

  function put(all) { store.set(KEY, all); }

  function rootOf(charId) {
    return (core && core.rootIdOf) ? core.rootIdOf(charId) : charId;
  }

  /** 读某角色（root 维度）当前岛的关系人账户表 */
  function list(charId, sandboxId) {
    var sid = sandboxId || ((core && core.activeSandboxId) ? core.activeSandboxId() : null);
    var root = rootOf(charId);
    var all = arr().filter(function (r) {
      return r && r.refCharId === root && (!sid || !r.sandboxId || r.sandboxId === sid);
    });
    return all;
  }

  /** 新建/更新账户（用户侧动作，可写全部字段）。返回该账户。 */
  function upsert(charId, rec) {
    if (!rec || !String(rec.name || '').trim()) return null;
    var sid = rec.sandboxId || ((core && core.activeSandboxId) ? core.activeSandboxId() : null);
    if (!sid) return null;
    var root = rootOf(charId);
    var all = arr();
    var now = Date.now();
    var hit = null;
    if (rec.id) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === rec.id && all[i].refCharId === root) { hit = all[i]; break; }
      }
    }
    if (hit) {
      /* 铁律：换名 = 换人，禁止（改名要删了重建） */
      if (rec.name && rec.name !== hit.name) return hit;
      ['relation', 'bond', 'note', 'learned', 'currentState'].forEach(function (k) {
        if (rec[k] !== undefined) hit[k] = String(rec[k]);
      });
      hit.updatedAt = now;
    } else {
      if (list(charId, sid).length >= SOFT_LIMIT) return null;   /* 别贪多 */
      hit = core.tagScope({
        id: 'rel-' + now + '-' + Math.random().toString(36).slice(2, 6),
        sandboxId: sid, refCharId: root,
        name: String(rec.name).trim(),
        relation: String(rec.relation || ''), bond: String(rec.bond || ''),
        note: String(rec.note || ''), learned: String(rec.learned || ''),
        currentState: String(rec.currentState || ''),
        openThreads: [], lastMentioned: 0,
        createdAt: now, updatedAt: now
      }, sid);
      all.push(hit);
    }
    put(all);
    return hit;
  }

  function remove(charId, accountId) {
    var root = rootOf(charId);
    var all = arr().filter(function (r) {
      return !(r && r.id === accountId && r.refCharId === root);
    });
    put(all);
  }

  /** 提及检测：文本里出现某关系人全名 → 记 lastMentioned（本地事实，不走提案）。
      返回被提到的账户数组。 */
  function touchMentioned(charId, sandboxId, text, now) {
    var t = String(text || '');
    if (!t) return [];
    var hit = [];
    var all = arr();
    list(charId, sandboxId).forEach(function (acc) {
      if (acc.name && t.indexOf(acc.name) !== -1) {
        acc.lastMentioned = now || Date.now();
        acc.updatedAt = acc.lastMentioned;
        hit.push(acc);
      }
    });
    if (hit.length) put(all);
    return hit;
  }

  /** 挑本轮该养的账户：最久没被喂/没被提的（fire-and-forget 用，每轮至多 1 个） */
  function pickForAdvance(charId, sandboxId, now) {
    var cands = list(charId, sandboxId).filter(function (a) {
      return now - (a.lastMentioned || 0) >= NEAR_STATE_GAP_MS &&
             now - (a.advancedAt || 0) >= NEAR_STATE_GAP_MS;
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return (a.advancedAt || 0) - (b.advancedAt || 0); });
    return cands[0];
  }

  /**
   * 应用 LLM 养出来的近况（page-chat 的 LLM 调用拿到 JSON 后调这里落库）。
   * patch: { currentState?, learned?, openThread?: {title, tone, open} }
   * 铁律闸：只许写 currentState/learned/openThreads；note 永不碰。
   * 返回更新后的账户；没找到返回 null。
   */
  function applyAdvance(charId, sandboxId, accountId, patch, now) {
    now = now || Date.now();
    var root = rootOf(charId);
    var all = arr();
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === accountId && all[i].refCharId === root) { hit = all[i]; break; }
    }
    if (!hit) return null;
    if (patch.currentState) hit.currentState = String(patch.currentState).slice(0, 120);
    if (patch.learned) {
      var add = String(patch.learned).slice(0, 80);
      /* learned 累积不覆盖旧印象（SullyOS 原口径），追加去重 */
      hit.learned = hit.learned ? (hit.learned + '；' + add) : add;
      if (hit.learned.length > 200) hit.learned = hit.learned.slice(-200);
    }
    if (patch.openThread && patch.openThread.title) {
      var ot = hit.openThreads = (Array.isArray(hit.openThreads) ? hit.openThreads : []);
      var open = ot.filter(function (t) { return t.open; });
      if (patch.openThread.open === false) {
        /* 了结同名悬置话题 */
        ot.forEach(function (t) { if (t.title === patch.openThread.title) t.open = false; });
      } else if (open.length < OPEN_THREAD_MAX &&
                 !ot.some(function (t) { return t.open && t.title === patch.openThread.title; })) {
        ot.push({
          id: 'ot-' + now, title: String(patch.openThread.title).slice(0, 40),
          open: true, intimacyGate: patch.openThread.intimacyGate || '可分享',
          tone: patch.openThread.tone === 'good' ? 'good' : 'bad',
          createdAt: now
        });
      }
    }
    hit.advancedAt = now;
    hit.updatedAt = now;
    put(all);
    return hit;
  }

  /** 注入摘要（挂 prompt）：印象强制「未必属实」措辞（铁律 2 的兜底就在这） */
  function buildSummary(charId, sandboxId) {
    var accs = list(charId, sandboxId);
    if (!accs.length) return '';
    var lines = accs.map(function (a) {
      var line = '- ' + a.name + (a.relation ? '（' + a.relation : '') + (a.bond ? '·' + a.bond + '）' : (a.relation ? '）' : ''));
      if (a.currentState) line += '：近况——' + a.currentState;
      var open = (a.openThreads || []).filter(function (t) { return t.open; });
      if (open.length) {
        line += '；悬着的事：' + open.map(function (t) { return t.title + (t.tone === 'good' ? '（好事）' : ''); }).join('、');
      }
      return line;
    });
    return '【身边的人（TA 的关系网）】\n' + lines.join('\n') +
      '\n（「近况/悬着的事」是 TA 自己的印象与传闻，未必属实；提到这些人时自然带出即可，别复述本段。）';
  }

  /** 给 LLM 的生长 prompt（page-chat 调 LLM 时用；本文件不发请求） */
  function buildAdvancePrompt(acc, recent) {
    return '你正在维护「' + (acc.name || '某人') + '」这个人设的社交关系（你是 ' +
      (acc.relation || '熟人') + '，视角是角色本人对这位熟人的了解）。\n' +
      (acc.currentState ? '已知近况：' + acc.currentState + '\n' : '') +
      (acc.note ? '用户确立的事实：' + acc.note + '\n' : '') +
      '最近的对话素材：\n' + (recent || '（无）') +
      '\n\n请基于素材更新这位熟人的近况。只输出一个 JSON：' +
      '{"currentState":"一句话近况（40字内，具体，别空话）","learned":"角色由此对该人新形成的印象（30字内，可空）","openThread":{"title":"悬着的一件事（20字内，可空）","tone":"good或bad","open":true}}\n' +
      '规则：素材里没有的不要编；没有值得悬着的事 openThread 整个留空或 open:false；只输出 JSON。';
  }

  Sleepy.taRelations = {
    list: list, upsert: upsert, remove: remove,
    touchMentioned: touchMentioned,
    pickForAdvance: pickForAdvance,
    applyAdvance: applyAdvance,
    buildSummary: buildSummary,
    buildAdvancePrompt: buildAdvancePrompt,
    SOFT_LIMIT: SOFT_LIMIT,
    NEAR_STATE_GAP_MS: NEAR_STATE_GAP_MS
  };

})(typeof window !== 'undefined' ? window : globalThis);
