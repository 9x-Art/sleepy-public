/* ============================================================
   page-phone-ai.js · 查手机生成链（第 2 批）

   Sleepy.phoneAI：
     · candFor()          模型选择（phoneApiCfg，语义同 memoryApiCfg，回落主 API）
     · gateFor(charId)    离屏结算闸门（自主生活档位 → 最短间隔）
     · settle(sbId,charId)  phone_life_settlement：一次调用产出跨 App 增量，
                           程序校验后事务写入；settledUntil 幂等，失败不推进
     · bootstrapPhone(...) phone_bootstrap：整部手机一生一次的初始底片
     · onChatTurn(chatId) 回复落地后的后台触发（不阻塞聊天，失败静默）

   架构红线（架构 v1 §1）：UI 页面不得直接调用模型 —— 本文件是领域服务，
   页面只喊 onChatTurn / 手动按钮，模型请求统一走这里。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var phone = Sleepy.phone;

  /* ---------------------------- 模型 ---------------------------- */

  function mainCand() {
    var main = store.get('mainApi');
    if (main && main.enabled && main.baseUrl && main.model) {
      return { source: 'main', label: main.name || '主 API', cfg: main };
    }
    return null;
  }

  function candFor() {
    var cfg = phone.apiCfg();
    if (cfg.mode === 'pick' && Sleepy.offlineStore && Sleepy.offlineStore.apiChoices) {
      var list = Sleepy.offlineStore.apiChoices();
      for (var i = 0; i < list.length; i++) {
        if (list[i].label === cfg.label) return list[i].cand;
      }
    }
    return mainCand();   /* 没指定或被删 → 主 API */
  }

  /* 「一个模型都没有」时给人看的**原因**。
     别写死「去配主 API」—— 用户很可能配的是副 API（审查报告六.1：
     「用户配了副 API 却被要求配主 API」）。 */
  function noApiReason() {
    var cfg = phone.apiCfg();
    if (cfg.mode === 'pick' && cfg.label) {
      return '指定的副 API「' + cfg.label + '」现在找不到了（可能被删），主 API 也没配';
    }
    return '主 API 还没配';
  }

  function callOnce(cand, messages) {
    if (!cand) return Promise.resolve({ ok: false, error: 'noapi' });
    return Sleepy.api.requestOnce(cand, messages, {}).then(function (res) {
      if (res.ok) return { ok: true, text: res.content };
      return { ok: false, error: Sleepy.api.describeError(res) };
    }, function (e) {
      return { ok: false, error: (e && e.message) || '请求失败' };
    });
  }

  /* 宽容解析：剥围栏、找第一个平衡的 JSON 对象（照 parseSummaryJson 的路数） */
  function parseSettlementJson(raw) {
    var s = String(raw || '').replace(/```json|```/g, '').trim();
    var a = s.indexOf('{');
    if (a < 0) return null;
    var depth = 0;
    for (var i = a; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(a, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /* ---------------------------- 输入装配 ---------------------------- */

  /* 三档底片。**以前 light / rich 两个按钮走的是同一句话**（档次在
     bootstrapPhone 里就丢了，等于那一项没实现）；2026-09-21 补上。
     差别只在「写多少」，不在「只写真实」—— 那是三条档位的共同前提。 */
  var BOOTSTRAP_ASK = {
    light: '请按输出协议产出初始生活底片：**只写最少、最真实的几条**' +
      '（每个 App 最多 1~2 条，宁少勿编）。',
    rich: '请按输出协议产出初始生活底片：**写得丰满一些**' +
      '（几个 App 各几条记录、一两个进行中的计划），但每一条都必须是这个人这时真的会有的东西。',
    /* 'real'（只用真实互动）根本不调模型，这里只是兜底别落空 */
    real: '请按输出协议产出初始生活底片（数量从少）。'
  };

  function contactsOf(sbId, charId) {
    var out = [];
    try {
      /* 岛里的合法联系人：NPC（岛内全体，唯一口径 core.npcsOfRoom）
         + 其他主角色（群岛）。
         ⚠️ 以前这里把 charId 当岛 id 传了进去（npcsOfRoom 找不到这段存档
         返回空），岛级 NPC 一直进不了联系人池 —— 2026-09-21 修掉。 */
      if (core.npcsOfRoom) {
        core.npcsOfRoom(sbId).forEach(function (n) {
          if (n && n.name) out.push(n.name + (n.speech ? '（' + String(n.speech).slice(0, 40) + '）' : ''));
        });
      }
      core.charsOfSandbox(sbId).forEach(function (c) {
        if (c.id !== charId && (c.kind || 'main') === 'main' && c.name) out.push(c.name);
      });
    } catch (e) { /* 联系人缺位不拦结算 */ }
    return out.slice(0, 10);
  }

  function recentContext(sbId, charId) {
    /* 最近少量真实事件：他与 user 的最近几条真实聊天（只做语境，不做来源） */
    var lines = [];
    try {
      var cs = Sleepy.chatStore;
      if (cs) {
        cs.getChats().filter(function (c) { return core.rootIdOf(c.characterId) === charId; })
          .forEach(function (c) {
            (c.messages || []).slice(-4).forEach(function (m) {
              if (m.role === 'system' || !m.content) return;
              lines.push((m.role === 'user' ? 'user' : (cs.findCharacter(c.characterId) || {}).name || 'char') +
                '：' + String(m.content).replace(/\s+/g, ' ').slice(0, 60));
            });
          });
      }
    } catch (e) { /* 没有聊天就空着 */ }
    return lines.slice(-8);
  }

  function buildMessages(sbId, ph, char, opts) {
    opts = opts || {};
    var sys = [Sleepy.promptEngine.cardBody('phoneLife')];
    if (char.content) sys.push('[CHARACTER]\n' + char.content + '\n[/CHARACTER]');
    if (opts.mode === 'bootstrap') sys.push('[MODE]\nbootstrap —— 初始生活底片，一生一次，遵守卡内「初始底片模式」一节。');

    var contacts = contactsOf(sbId, char.id);
    var user = [];
    user.push('[WORLD]\n岛屿：' + ((core.findSandbox(sbId) || {}).name || '') +
      '。合法联系人（幕后交流对象只能从里面选）：' + (contacts.join('、') || '暂无（不要编造新亲友）'));
    var plans = phone.plansOf(ph.id).filter(function (p) {
      return ['brewing', 'preparing', 'scheduled'].indexOf(p.status) >= 0;
    });
    if (plans.length) {
      user.push('[PLANS]\n进行中的计划（planChanges 只能操作这些）：\n' +
        plans.map(function (p) { return '- ' + p.title + '（' + p.status + '）'; }).join('\n'));
    }
    var recent = recentContext(sbId, char.id);
    if (recent.length) user.push('[RECENT]\n最近的互动（只做语境参考）：\n' + recent.join('\n'));
    var from = opts.from ? new Date(opts.from).toLocaleString('zh-CN') : '角色创建以来';
    user.push('[RANGE]\n结算时间段：' + from + ' ～ 现在。只生成这段时间里合理发生的事。');
    user.push(opts.mode === 'bootstrap'
      ? (BOOTSTRAP_ASK[opts.level] || BOOTSTRAP_ASK.light)
      : '请按输出协议结算这段时间的生活（没有合理内容就返回空 deltas）。');

    return [
      { role: 'system', content: sys.join('\n\n') },
      { role: 'user', content: user.join('\n\n') }
    ];
  }

  /* ---------------------------- 结算 ---------------------------- */

  var running = {};

  function settle(sbId, charId, opts) {
    opts = opts || {};
    var char = core.findChar(charId);
    if (!char) return Promise.resolve({ ok: false, error: '找不到角色' });
    if (running[charId]) return Promise.resolve({ ok: false, error: '正在结算中' });

    var ph = phone.ensurePhone(sbId, charId);
    var cand = candFor();
    /* 一个模型都没有时，连同「为什么」一起返回 —— 页面拿它给一句准确的话 */
    if (!cand) return Promise.resolve({ ok: false, error: 'noapi', reason: noApiReason() });

    var from = ph.settledUntil || ph.createdAt;
    var messages = buildMessages(sbId, ph, char, {
      mode: opts.mode,
      level: opts.level,          /* 底片档位（light / rich），别在这儿丢掉 */
      from: opts.mode === 'bootstrap' ? null : from
    });
    var runId = 'run_' + Date.now().toString(36);

    running[charId] = true;
    return callOnce(cand, messages).then(function (r) {
      running[charId] = false;
      if (!r.ok) return r;                      /* 失败不推进 settledUntil，下次补 */
      var parsed = parseSettlementJson(r.text);
      if (!parsed) {
        /* 原文留下来，并且记下**这次是什么活儿、哪一档** ——
           页面上的「再试一次」要靠它复原（以前只存 at/raw，
           phoneRawFail 全仓没有一处读，等于没有重试入口）。 */
        store.set('phoneRawFail:' + charId, {
          at: Date.now(), mode: opts.mode || 'settle', level: opts.level || null,
          raw: String(r.text || '').slice(0, 4000)
        });
        return { ok: false, error: '解析失败（原文已存）' };
      }
      /* 幂等：bootstrap 只允许成功一次 */
      if (opts.mode === 'bootstrap') {
        if (ph.bootstrapStatus === 'completed') return { ok: false, error: '已经初始化过了' };
      }
      var stat = phone.applySettlement(ph, parsed, runId);
      var patch = { settledUntil: Date.now() };
      if (opts.mode === 'bootstrap') {
        patch.bootstrapStatus = 'completed';
        patch.bootstrapMode = opts.level || 'light';   /* 记下用的是哪一档 */
        patch.bootstrapVersion = (ph.bootstrapVersion || 0) + 1;
        patch.bootstrapRunId = runId;
      }
      /* 顺手把可检测痕迹标记为「他已可能发现」—— 消费端在聊天注入槽 */
      var detected = phone.markDetected(ph.id);
      store.set('phoneRawFail:' + charId, null);
      return { ok: true, stat: stat, detected: detected };
    });
  }

  /* bootstrap：user 显式点「补上初始底片」才跑。只真实模式 = 0 次调用。 */
  function bootstrapPhone(sbId, charId, mode) {
    var ph = phone.ensurePhone(sbId, charId);
    if (ph.bootstrapStatus === 'completed') return Promise.resolve({ ok: false, error: '已经初始化过了' });
    if (mode === 'real') {                       /* 只使用真实互动：尊重真实空态 */
      phone.getPhone(ph.id) && phone_applyPatch(ph.id, {
        bootstrapStatus: 'completed', bootstrapMode: 'real', settledUntil: Date.now()
      });
      return Promise.resolve({ ok: true, stat: { applied: 0 }, real: true });
    }
    /* level 一路带进 buildMessages —— 以前在这儿丢掉了，于是
       「轻量底片」和「丰富底片」两个按钮生成的提示词一模一样。 */
    return settle(sbId, charId, { mode: 'bootstrap', level: mode });
  }

  function phone_applyPatch(phoneId, patchObj) {
    /* phone.js 的 patch 是内部的 —— 走 getPhone+savePhone 组合 */
    var ph = phone.getPhone(phoneId);
    if (!ph) return null;
    Object.keys(patchObj).forEach(function (k) { ph[k] = patchObj[k]; });
    phone.savePhone(ph);
    return ph;
  }

  /* ---------------------------- 触发 ---------------------------- */

  /* 回复落地后：闸门通过就后台结算，不阻塞聊天（照总结引擎的静默规矩） */
  function onChatTurn(chatId) {
    var cs = Sleepy.chatStore;
    var chat = cs && cs.getChat(chatId);
    if (!chat || !chat.characterId) return;
    var sbId = core.scopeId();
    if (!sbId) return;
    var charId = core.rootIdOf(chat.characterId);
    var gate = phone.gateFor(charId);
    if (!gate.allowed) return;
    settle(sbId, charId).then(function (r) {
      /* 静默；只有结算真写入了东西才轻提一句 */
      if (r.ok && r.stat && r.stat.applied > 0 && Sleepy.toast) {
        Sleepy.toast('他的生活悄悄往前走了一点（' + r.stat.applied + ' 条新痕迹）', 'ok');
      }
    });
  }

  /* 被抓现行：char 的即时反应（方案-查手机硬翻-v1，2026-09-21 拍板：
     「被发现我觉得要交给 char 决定要怎么做」）。只生成「他说什么做什么」，
     不决定玩法惩罚 —— 手机怎么处置由剧情接着演。
     返回 Promise<{ok, text}> 或 {ok:false, error}（'noapi' 或 describeError 的人话）。 */
  function caughtReaction(sbId, charId, caughtCtx) {
    var char = core.findChar(charId);
    if (!char) return Promise.resolve({ ok: false, error: '找不到角色' });
    var cand = candFor();
    if (!cand) return Promise.resolve({ ok: false, error: 'noapi' });
    var where = (caughtCtx && caughtCtx.where) || 'lock';
    var WHERE_TXT = {
      lock: '手机还停在密码界面，屏幕上是输错的痕迹',
      desktop: '他回来的时候，手机就在你手里',
      messages: '你正停在「消息」里',
      taobao: '你正停在「淘宝」里',
      notes: '你正停在「备忘录」里',
      browser: '你正停在「浏览器」里',
      health: '你正停在「健康打卡」里',
      gallery: '你正在翻他的相册'
    };
    var sys = [Sleepy.promptEngine.cardBody('phoneCaught')];
    if (char.content) sys.push('[CHARACTER]\n' + String(char.content).slice(0, 800) + '\n[/CHARACTER]');
    var user = ['[SCENE]\n你回到房间，发现 user 正拿着你的手机 —— ' +
      (WHERE_TXT[where] || WHERE_TXT.desktop) + '。'];
    var recent = recentContext(sbId, char.id);
    if (recent.length) user.push('[RECENT]\n你们最近的互动（只做语境）：\n' + recent.join('\n'));
    user.push('（直接输出你这一刻的反应。）');
    return callOnce(cand, [
      { role: 'system', content: sys.join('\n\n') },
      { role: 'user', content: user.join('\n\n') }
    ]);
  }

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.phoneAI = {
    candFor: candFor,
    parseSettlementJson: parseSettlementJson,
    settle: settle,
    bootstrapPhone: bootstrapPhone,
    caughtReaction: caughtReaction,
    gateFor: function (charId) { return phone.gateFor(charId); },
    onChatTurn: onChatTurn
  };

})(window);
