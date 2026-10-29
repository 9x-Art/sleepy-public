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

  /* ★ 2026-10-10 用户反馈：每个 App 页面要能单独刷新，且每页用**新的提示词**
     （首页右上角的「刷新」走整体结算 phoneLife 原卡；各 App 页里的刷新
     只产出这个 App 的 deltas —— 限定范围写在 [FOCUS]，本体协议卡不变）。
     每页的「新提示词」= 共同协议卡 + 该 App 的专属指令 + 已有条目防重复。 */
  var APP_FOCUS_ASK = {
    /* 2026-10-29 用户反馈：每个 App 每次刷新要「五个左右」，1~3 太抠 ——
       硬性条数统一改成 3~5。 */
    messages: '这次**只更新「消息」App**：给出 **3～5 条** deltas —— 他和合法联系人的幕后交流（一来一回）、或一条没发出去的草稿。deltas 里其他 App 一律不要出现。',
    taobao:   '这次**只更新「淘宝」App**：给出 **3～5 条** deltas —— 新下单的东西 / 既有订单状态往前推一步 / 收藏 / 加购。deltas 里其他 App 一律不要出现。',
    health:   '这次**只更新「健康打卡」App**：给出 **3～5 条** deltas —— 最近几天里挑有内容的日子写：三餐零食、运动计划与实际、他自己的短评（一个 App 页一条日记录即可）。deltas 里其他 App 一律不要出现。',
    notes:    '这次**只更新「备忘录」App**：给出 **3～5 条** deltas —— 他随手记下的几条备忘（可以带 folder）。deltas 里其他 App 一律不要出现。',
    browser:  '这次**只更新「浏览器」App**：给出 **3～5 条** deltas —— 几次搜索或几个收藏。deltas 里其他 App 一律不要出现。',
    music:    '这次**只更新「音乐」App**：给出 **3～5 条** deltas —— 他最近在听的几首歌（loops 是这段时间单曲循环了几遍，多数是 0~2，循环很多遍说明他有心事）、或红了心的歌。note 是他为什么单听这首的一句心声（可空）。deltas 里其他 App 一律不要出现。',
    sms:      '这次**只更新「短信」App**：给出 **3～5 条**有剧情意义的**真人短信**（kind=chat，from 只能是岛里已登记的人或已登记的背景联系人）；think 写他看到（或发出）这条短信时的一句心声，可空。验证码/快递这类系统通知由程序生成，你不要写。deltas 里其他 App 一律不要出现。',
    books:    '这次**只更新「书架」App**：给出 **3～5 条** deltas —— 在读的书推进了进度（或开了新书）、和/或几条划线批注（text=书里原文，think=他自己的话，两者别混）。deltas 里其他 App 一律不要出现。'
  };

  /* 单 App 已有条目的简表（防重复 —— 模型看不到库，只能喂给它） */
  function existingBrief(ph, appKey) {
    var out = [];
    if (appKey === 'messages') {
      phone.derivedMsgs(ph.id).slice(0, 8).forEach(function (m) {
        out.push('- ' + (m.kind === 'draft' ? '草稿：' : '与' + (m.withName || '?') + '：') +
          (((m.lines || [])[0] || {}).text || '').slice(0, 30));
      });
    } else if (appKey === 'browser') {
      phone.listBrowser(ph.id).slice(0, 8).forEach(function (x) {
        out.push('- ' + (x.kind === 'bookmark' ? '收藏：' : '搜索：') + x.query);
      });
    } else if (appKey === 'notes') {
      phone.listNotes(ph.id).slice(0, 8).forEach(function (x) {
        out.push('- ' + (x.title || String(x.content || '').slice(0, 30)));
      });
    } else if (appKey === 'health') {
      phone.listHealth(ph.id).slice(0, 4).forEach(function (x) {
        out.push('- ' + (x.day || '一天') + '：' + ((x.meals || [])[0] || {}).text);
      });
    } else if (appKey === 'taobao') {
      phone.listShop(ph.id).slice(0, 8).forEach(function (x) {
        out.push('- ' + x.title + '（' + x.status + '）');
      });
    } else if (appKey === 'music') {
      phone.listMusic(ph.id).slice(0, 8).forEach(function (x) {
        out.push('- ' + (x.kind === 'like' ? '红心：' : '在听：') + x.title +
          (x.artist ? '（' + x.artist + '）' : '') +
          (x.loops > 0 ? ' 循环×' + x.loops : ''));
      });
    } else if (appKey === 'sms') {
      phone.listSms(ph.id).slice(0, 6).forEach(function (x) {
        out.push('- ' + (x.kind === 'chat' ? '短信 ' : '通知 ') + x.from + '：' +
          String(x.text || '').slice(0, 24));
      });
    } else if (appKey === 'books') {
      phone.listBooks(ph.id).slice(0, 5).forEach(function (x) {
        out.push('- 在读《' + x.title + '》' + (x.progress != null ? x.progress + '%' : ''));
      });
      phone.listBookNotes(ph.id).slice(0, 4).forEach(function (x) {
        out.push('- 批注《' + x.title + '》：' + String(x.text || '').slice(0, 24));
      });
    }
    return out;
  }

  function contactsOf(sbId, charId, ph) {
    var out = [];
    function push(name) {
      if (name && out.indexOf(name) < 0) out.push(name);
    }
    try {
      /* 岛里的合法联系人：NPC（岛内全体，唯一口径 core.npcsOfRoom）
         + 其他主角色（群岛）+ 皮套（挂角色名下的小号）+ user 的马甲。
         ⚠️ 以前这里把 charId 当岛 id 传了进去（npcsOfRoom 找不到这段存档
         返回空），岛级 NPC 一直进不了联系人池 —— 2026-09-21 修掉。
         2026-10-29：皮套和马甲也进池（校验池 phone.knownPeople 本来就认，
         提示词池却一直缺 —— 模型明明可以写却被告知不许）。 */
      if (core.npcsOfRoom) {
        core.npcsOfRoom(sbId).forEach(function (n) {
          if (n && n.name) push(n.name + (n.speech ? '（' + String(n.speech).slice(0, 40) + '）' : ''));
        });
      }
      core.charsOfSandbox(sbId).forEach(function (c) {
        if (!c || !c.name) return;
        if (c.id !== charId && (c.kind || 'main') === 'main') push(c.name);
        if (c.id === charId) {
          (Sleepy.island
            ? Sleepy.island.childrenOf(sbId, c.id, 'sub', 'char')
            : core.subChars(c.id)).forEach(function (s) {
              if (s && s.name) push(s.name);
            });
        }
      });
      (core.masksOfSandbox ? core.masksOfSandbox(sbId) : []).forEach(function (u) {
        if (u && u.name) push(u.name);
      });
      /* 已登记的背景联系人也在池里（首次登记见 settle → applySettlement） */
      ((ph && ph.bgContacts) || []).forEach(push);
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
    /* 人设唯一出口 compileCharacter（分层+红线并集），不再裸 content（勘察 P1） */
    var personaBlock = Sleepy.promptEngine.compileCharacter(char.id);
    if (personaBlock) sys.push(personaBlock);
    if (opts.mode === 'bootstrap') sys.push('[MODE]\nbootstrap —— 初始生活底片，一生一次，遵守卡内「初始底片模式」一节。');
    if (opts.appOnly) sys.push('[MODE]\napp-refresh —— 手动单 App 刷新：只允许产出 [FOCUS] 指定 App 的 deltas，其余 App 一律为空。');

    var contacts = contactsOf(sbId, char.id, ph);
    /* 2026-10-29 用户点名：user 没设 NPC 时，消息/短信不该一直是空的 ——
       允许模型根据人设和聊天记录编 1~2 个背景联系人，程序会登记
       （phone.applySettlement 的 allowBgContacts 口子）。 */
    var allowBg = contacts.length === 0;
    opts.allowBg = allowBg;   /* 回带给 settle —— 落库校验用同一把尺子 */
    var user = [];
    user.push('[WORLD]\n岛屿：' + ((core.findSandbox(sbId) || {}).name || '') +
      '。合法联系人（幕后交流对象只能从里面选）：' + (contacts.join('、') || '暂无') +
      (allowBg
        ? '\n联系人池是空的：你可以根据他的人设、职业和最近的聊天，安排 1～2 个**背景联系人**' +
          '（朋友 / 同事 / 家人，名字要像真人、符合他的背景）。程序会把他们登记进通讯录，之后的结算继续认。'
        : ''));
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
    if (opts.appOnly) {
      user.push('[FOCUS]\n' + (APP_FOCUS_ASK[opts.appOnly] || ''));
      var exist = existingBrief(ph, opts.appOnly);
      if (exist.length) {
        user.push('[EXIST]\n' + (APP_LABEL_OF[opts.appOnly] || opts.appOnly) +
          '里已有的条目（不要重复，要新的东西）：\n' + exist.join('\n'));
      }
      /* 2026-10-23 用户点名：手动刷新必须出东西 —— 「没有合理的就返回空」
         是模型偷懒的出口（真机连点全弹「没有新动静」）。单 App 刷新改成
         硬性 1～3 条；实在想不出大事就写他今天最可能做的小事。
         整段结算（else 分支）仍允许空 —— 那是后台自动跑，不该硬凑。 */
      user.push('请按输出协议产出这个 App 的新内容（**必须给出 3～5 条 deltas，五个左右，禁止返回空 deltas** —— ' +
        '这是 user 手动点的刷新，一定要有新东西；想不出大事，就写他今天最可能做的几件小事）。');
      if (opts.nudge) {
        user.push('[RETRY]\n上一轮你返回了空 deltas（或全部无效），已被退回。这一轮**必须**给出 3～5 条能落地的 deltas。');
      }
    } else {
      user.push(opts.mode === 'bootstrap'
        ? (BOOTSTRAP_ASK[opts.level] || BOOTSTRAP_ASK.light)
        : '请按输出协议结算这段时间的生活（没有合理内容就返回空 deltas）。');
      if (opts.nudge) {
        user.push('[RETRY]\n上一轮你返回了空 deltas（或全部无效），已被退回。这一轮**必须**给出 3～5 条能落地的 deltas —— ' +
          '从这段时间里他最可能做的小事里挑着写，不许再返回空。');
      }
    }

    return [
      { role: 'system', content: sys.join('\n\n') },
      { role: 'user', content: user.join('\n\n') }
    ];
  }

  /* ---------------------------- 结算 ---------------------------- */

  var running = {};

  /* App 页刷新用的中文名（[EXIST] 提示行） */
  var APP_LABEL_OF = {
    messages: '消息', taobao: '淘宝', health: '健康打卡', notes: '备忘录', browser: '浏览器',
    music: '音乐', sms: '短信', books: '书架'
  };

  /* ★ 2026-10-10 单 App 手动刷新（App 页右上角按钮）：
     复用 settle 的链路（同协议卡、同校验、同落库），只是提示词换成
     「只出这个 App」。appKey 只认官方五个；工坊自定义 App 不接刷新。 */
  function refreshApp(sbId, charId, appKey) {
    if (!APP_FOCUS_ASK[appKey]) {
      return Promise.resolve({ ok: false, error: '这个 App 还不支持单独刷新' });
    }
    /* 2026-10-23 用户点名「只要刷新就要有新东西」：空手由 settle 内部
       （force）自动补写一轮；解析失败在这外面再补一轮。 */
    return settle(sbId, charId, { appOnly: appKey, force: true }).then(function (r) {
      if (!(!r.ok && /解析失败/.test(r.error || ''))) return r;
      return settle(sbId, charId, { appOnly: appKey, nudge: true });
    });
  }

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
      appOnly: opts.appOnly,      /* 单 App 刷新（各 App 页的刷新按钮） */
      nudge: opts.nudge,          /* 空手退回后的补写轮（2026-10-23） */
      from: opts.mode === 'bootstrap' ? null : from
    });
    /* buildMessages 判定了这回合是否开了「背景联系人」口子（联系人池为空
       才开），结算落库时用同一把尺子 —— 提示词和校验必须一致。 */
    var allowBg = !!opts.allowBg;
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
      var stat = phone.applySettlement(ph, parsed, runId, { allowBgContacts: allowBg });
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
      /* 2026-10-23 用户点名「只要刷新就要有新东西」：手动刷新（force）空手
         而归时自动补写一轮（[RETRY] 退回指令）。bootstrap 不递归（幂等门禁
         在上面已经 completed 拦过）；补写轮 force 不传 —— 两轮都空就如实
         回给页面，不无限烧调用。 */
      if (opts.force && !opts.nudge && opts.mode !== 'bootstrap' &&
          r.ok && stat.applied === 0) {
        return settle(sbId, charId, {
          appOnly: opts.appOnly, nudge: true
        });
      }
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
      music: '你正停在「音乐」里',
      sms: '你正停在「短信」里',
      books: '你正停在「书架」里'
    };
    var sys = [Sleepy.promptEngine.cardBody('phoneCaught')];
    /* 人设唯一出口 compileCharacter；旧 slice(0,800) 截断已删（勘察 P0） */
    var caughtPersona = Sleepy.promptEngine.compileCharacter(char.id);
    if (caughtPersona) sys.push(caughtPersona);
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
    refreshApp: refreshApp,
    APP_FOCUS_ASK: APP_FOCUS_ASK,
    bootstrapPhone: bootstrapPhone,
    caughtReaction: caughtReaction,
    gateFor: function (charId) { return phone.gateFor(charId); },
    onChatTurn: onChatTurn
  };

})(window);
