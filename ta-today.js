/* ============================================================
   ta-today.js — 活人系统 · L2 今日状态块（2026-10-25）

   一天一次生成的「今天的他」：mood / occupation / towardYou / smallThing，
   挂系统提示最前。设计口径：
     · date 是否属今天判定要不要重算；旧记录作废不迁移；
     · 素材只从账本读（关系网 taRelations / 已成立影响 taImpact），不随机；
     · 空材料合法：抽不出就留空；
     · 生成失败静默降级，绝不阻塞主链路。
   生成走直接落库（sleepy 先例：schedule-gen.js——系统状态非事实写入）。

   纪律：键 taToday 已双登记（DEFAULTS + cleanupSandbox）；refCharId 归
   root；写入 tagScope 盖岛章 + 全量 set。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var core = Sleepy.core;
  var store = Sleepy.store;

  var KEY = 'taToday';

  function localDateKey(now) {
    var d = now ? new Date(now) : new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function rootOf(charId) {
    return (core && core.rootIdOf) ? core.rootIdOf(charId) : charId;
  }

  /** 读今天的块：date 属今天才有效（旧块作废，返回 null） */
  function get(charId, sandboxId, now) {
    var sid = sandboxId || ((core && core.activeSandboxId) ? core.activeSandboxId() : null);
    var root = rootOf(charId);
    var today = localDateKey(now);
    var list = store.get(KEY);
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r && r.refCharId === root && r.date === today &&
          (!sid || !r.sandboxId || r.sandboxId === sid)) return r;
    }
    return null;
  }

  /** 落块（LLM 生成成功后由调用方喂入；字段全部直传，date 由这里定） */
  function put(charId, sandboxId, fields, now) {
    var sid = sandboxId || ((core && core.activeSandboxId) ? core.activeSandboxId() : null);
    if (!sid) return null;
    var root = rootOf(charId);
    var today = localDateKey(now);
    var all = store.get(KEY);
    if (!Array.isArray(all)) all = [];
    var hit = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].refCharId === root && all[i].date === today &&
          (!sid || !all[i].sandboxId || all[i].sandboxId === sid)) { hit = all[i]; break; }
    }
    if (!hit) {
      hit = core.tagScope({
        id: 'td-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        sandboxId: sid, refCharId: root, date: today,
        mood: '', occupation: '', towardYou: '', smallThing: '',
        createdAt: Date.now(), updatedAt: Date.now()
      }, sid);
      all.push(hit);
    }
    ['mood', 'occupation', 'towardYou', 'smallThing'].forEach(function (k) {
      if (fields && fields[k]) hit[k] = String(fields[k]).slice(0, 60);
    });
    hit.updatedAt = Date.now();
    store.set(KEY, all);
    return hit;
  }

  /** 素材摘要（喂给 LLM；只从账本读，不随机） */
  function buildMaterial(charId, sandboxId) {
    var parts = [];
    if (Sleepy.taRelations) {
      var rel = Sleepy.taRelations.buildSummary(charId, sandboxId);
      if (rel) parts.push(rel);
    }
    return parts.join('\n\n');
  }

  /** 给 LLM 的生成 prompt（本文件不发请求） */
  function buildPrompt(charName, material) {
    return '你要为「' + charName + '」生成今天一天的状态底色（第一人称内心，第三人称描述均可，但别出戏）。\n' +
      (material ? '素材（TA 的关系网等账本）：\n' + material + '\n' : '（今天没有账本素材——留空是合法的，别硬编。）\n') +
      '只输出一个 JSON：{"mood":"今天的心情基调（15字内，允许真负面）","occupation":"这阵子在忙/想什么（30字内，从素材抽）","towardYou":"此刻对用户的状态（15字内：想你了/有点闷/在闹脾气…）","smallThing":"今天想跟规格说明的一件小事（30字内，从素材抽，抽不出留空）"}\n' +
      '规则：素材里没有的别编；只输出 JSON。';
  }

  /** 注入块（挂 prompt 最前）：今天的块存在才给 */
  function buildContext(charId, sandboxId, now) {
    var b = get(charId, sandboxId, now);
    if (!b) return '';
    var lines = ['【今天的你】'];
    if (b.mood) lines.push('心情：' + b.mood);
    if (b.occupation) lines.push('这阵子在忙：' + b.occupation);
    if (b.towardYou) lines.push('此刻对 ta：' + b.towardYou);
    if (b.smallThing) lines.push('想找机会跟 ta 说的小事：' + b.smallThing);
    if (lines.length === 1) return '';
    return lines.join('\n') + '\n（这是你自己的状态底色，自然带进语气即可，别复述本段。）';
  }

  Sleepy.taToday = {
    get: get, put: put,
    buildMaterial: buildMaterial,
    buildPrompt: buildPrompt,
    buildContext: buildContext,
    localDateKey: localDateKey
  };

})(typeof window !== 'undefined' ? window : globalThis);
