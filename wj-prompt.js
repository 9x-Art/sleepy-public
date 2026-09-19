/* ============================================================
   wj-prompt.js — 帷境 · 提示词装配（三支：故事规划 / 正文生成 / 局部重写）
   依赖：wj-data.js（词表与文风）、core.js（人物）、prompt-engine.js
         （langOfChar / estimate，惰性）、calendar.js（timeFacts，惰性）
   被依赖：wj-engine.js（唯一调用方）

   ★ 这一层**一次网络请求都不发** —— 它只负责把 messages 装配出来、
   把模型的返回解析出来。真正的调用在 wj-engine.js，那里有可注入的
   transport（冒烟桩用它喂假文本，真机走 Sleepy.api）。

   与聊天的关系：**不共用 ONLINE_SLOTS / OFFLINE_SLOTS**。帷境不是对话，
   它的输出是一篇作品的正文，槽位族单独一套（方案 §3「需要新开一套
   WJ_* 槽位，不塞进聊天」）。

   红线：
   · 时间只走 Sleepy.calendar.timeFacts（不自己手写日期字符串）；
   · 三层权限在提示词里也分开表述：取材块只讲「能读什么」，
     现实块只讲「这篇算什么」，知情这件事**根本不进提示词** ——
     人物知不知情是产品层的存储问题，不是模型能决定的；
   · 正文协议是「一篇连续的叙事」，段落类型只是给程序排版的标记
     （与线下定稿同一套写法纪律，别退化成一句一段的短段）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var D = function () { return Sleepy.wj; };

  /* ------------------------- 小工具 ------------------------- */

  function findChar(id) {
    try { return Sleepy.core.findChar(id) || null; } catch (e) { return null; }
  }

  /* 时间事实：唯一出处。拿不到就整块省略，**绝不自己编日期**。 */
  function timeBlock(work) {
    var lead = ((work && work.cast) || []).filter(function (x) { return x.role === 'lead'; })[0];
    var cal = Sleepy.calendar;
    if (!lead || !cal || !cal.timeFacts) return '';
    try {
      var f = cal.timeFacts(lead.charId);
      if (!f || !f.nowText) return '';
      return '【时间事实】故事外的「现在」是：' + f.nowText +
        '。这篇作品发生在上面选定的空白里，不要引用现实新闻或真实年份的事件。';
    } catch (e) { return ''; }
  }

  /* 出场人物：只给基础人设与本篇身份。本篇身份（identity）属于这篇故事，
     不写回角色档案 —— 这就是「本篇身份」与「现实身份」的分界。 */
  function castBlock(work) {
    var cast = (work && work.cast) || [];
    if (!cast.length) return '';
    var lines = ['【出场人物】（现实身份提供底色，本篇身份只属于这篇故事）'];
    cast.forEach(function (x, i) {
      var role = x.role === 'lead' ? '主角' : x.role === 'support' ? '配角' : '出场人物';
      var c = findChar(x.charId);
      var brief = String((c && c.content) || '').trim();
      lines.push('· ' + (x.name || '人物') + '（' + role + '）' +
        (x.identity ? ' · 本篇身份：' + x.identity : ''));
      if (brief) lines.push('  人设：' + brief.slice(0, 900));
      if (i === 0 && c && c.city) {
        lines.push('  常驻：' + [c.city, c.region].filter(Boolean).join(' · '));
      }
    });
    return lines.join('\n');
  }

  /* user 位置与取材，都只说清「能做什么、不能做什么」。 */
  function userPosBlock(work) {
    var pos = D().USER_POS_LABEL[work.userPos] || '幕外旁观';
    var lines = ['【user 的位置】' + pos + '。'];
    if (work.userPos === 'hidden') {
      lines.push('user 完全不出场。不要把故事强行绕回 user，' +
        '不要把人物的过去写成「为了日后遇见 user」。');
    } else if (work.userPos === 'observer') {
      lines.push('user 只在幕后旁观，不作为人物出现在正文里。');
    }
    return lines.join('\n');
  }

  function materialBlock(work) {
    var id = work.materialScope;
    var lines = ['【创作取材】'];
    if (id === 'none') {
      lines.push('只使用上面给出的人设与本篇设定。不引用任何共同经历或既有事件。');
    } else if (id === 'tone') {
      lines.push('可以使用人物之间的关系与性格底色（他们如何思考、如何相处、关系的基调），' +
        '但不引用具体的共同事件。');
    } else if (id === 'select') {
      /* 逐条勾选器还没接入取材系统 —— 如实降级为 tone 档执行，不装作读到了。 */
      lines.push('（逐条授权尚不可用，本篇暂按「只读关系与性格底色」执行。）' +
        '可以使用人物之间的关系与性格底色，不引用具体的共同事件。');
    } else if (id === 'world') {
      var names = ((work.sandboxIds) || []).map(function (sid) {
        try {
          var sb = Sleepy.core.listSandboxes().filter(function (x) { return x.id === sid; })[0];
          return sb ? sb.name : '';
        } catch (e) { return ''; }
      }).filter(Boolean);
      lines.push('可以贴合他们现在的生活世界取材' +
        (names.length ? '（来源世界：' + names.join('、') + '）' : '') +
        '；生活细节可以具体，但不要逐条复述任何「已发生的事件流水」。');
    } else {
      lines.push('只使用上面给出的人设与本篇设定。');
    }
    lines.push('取材只是写作素材：这**不代表**任何人物知道这篇作品存在。');
    return lines.join('\n');
  }

  /* 作品真实性：story / parallel / canon_candidate。canonized 是审阅后的
     只读结果，不会再有生成，这里不用管。 */
  function realityBlock(work) {
    var r = D().realityOf(work);
    var t = D().TIME_ANCHOR_LABEL[work.timeAnchor] || '';
    var lines = ['【作品性质】' + r.name + (t ? ' · 时间落点：' + t : '') + '。'];
    if (work.reality === 'canon_candidate') {
      lines.push('这篇发生在角色时间线的空白处：与既有经历不矛盾，但**尚未成为事实**。' +
        '人物不知道它，它也不会自动写入任何人的记忆。');
    } else if (work.reality === 'parallel') {
      lines.push('这篇是一段与既有时间线无关的平行可能：人物的身份与命运在这里可以与现实中不同。');
    } else {
      lines.push('这篇只是作品：可以自由虚构与加工，不必与现实时间线对齐。');
    }
    return lines.join('\n');
  }

  /* 文风：四参数翻成写作指令。四根滑杆只是控制台的一部分 ——
     真正的雷区拦截与只重写问题段在 T4，这里先把参数如实翻译。 */
  function styleBlock(work) {
    var st = D().styleOf(work);
    var p = st.params;
    function band(v, lo, hi, loText, midText, hiText) {
      if (v <= 33) return loText;
      if (v >= 67) return hiText;
      return midText;
    }
    var lines = ['【文风】底座：' + st.name];
    lines.push('· 叙述距离：' + band(p.distance, 0, 100,
      '贴身 —— 紧贴人物感官与呼吸，读者几乎住在他的皮肤里',
      '中等距离 —— 贴着人物走，但保留观察的余地',
      '远景 —— 克制的旁观，像隔着一段时间的目光'));
    lines.push('· 语言密度：' + band(p.density, 0, 100,
      '稀疏 —— 留白多于描写，短句为主，形容词能删就删',
      '中等密度 —— 描写与叙事均衡',
      '丰沛 —— 细节绵密，允许长句与铺陈'));
    lines.push('· 叙事节奏：' + band(p.pace, 0, 100,
      '停驻 —— 愿意在一件小事上停留很久',
      '中速 —— 张弛有度',
      '紧凑 —— 场景推进快，删掉一切不推动时间的部分'));
    lines.push('· 对话占比：' + band(p.dialogue, 0, 100,
      '少对白 —— 对话要少而重，每一句都有分量',
      '对白与叙述均衡',
      '多对白 —— 让对话承担叙事，人物在说话里互相试探'));
    return lines.join('\n');
  }

  /* 雷区：全局里已确认的 + 本篇的。候选（confirmed:false）**不生效**。 */
  function rulesBlock(work) {
    var cfg = D().styleCfg();
    var rules = (cfg.globalRules || []).filter(function (r) { return r && r.confirmed; })
      .map(function (r) { return r.text + '（' + r.strength + '）'; });
    (work.workRules || []).forEach(function (r) {
      if (r && r.text) rules.push(r.text + '（' + (r.strength || '尽量避免') + '·本篇）');
    });
    if (!rules.length) return '';
    return ['【雷区】以下写法被明令限制：'].concat(rules.map(function (x) {
      return '· ' + x;
    })).join('\n');
  }

  /* 篇幅：按作品篇幅档给**每一章**的目标字数。 */
  function lengthBlock(work) {
    var map = {
      '短篇': [900, 1400], '中篇': [1600, 2400], '长篇': [2400, 3600]
    };
    var rng = map[work.length] || map['短篇'];
    return '本章正文合计约 ' + rng[0] + ' ~ ' + rng[1] + ' 字（这是整章字数，不是每段）。';
  }

  /* 写法纪律：与线下那篇连续叙事同源。段落类型只是排版标记。 */
  var WRITING = [
    '【写法】你写的是一篇连续的叙事，不是台本，不是分镜：',
    '· 描写与心理是主体；同一段叙述要成段（两三句），不要一句一段；',
    '· 有想说的才写对话——没人开口就整章只有叙述，不许为凑对话硬写；',
    '· 场面要有具体的物与动静；位置关系要立得住；',
    '· 心理活动写在叙述里，不单独成块。'
  ].join('\n');

  var OUTPUT_PROTO = [
    '【输出】只输出一个 JSON 对象（不要代码围栏、不要解释）：',
    '{"paras":[{"type":"prose","text":"……"}],',
    ' "choices":[{"label":"岔路名","hint":"一句话说明这条路通向什么"}]}',
    'paras 的 type 只能取：prose（叙述，含心理与动作）/ dialogue（台词，带说话人，' +
    '说话人写在句首） / memory（回忆，斜体感） / scene_break（空 text，表示场景转换）。',
    'choices 是**章末故事岔路**：只在故事自然出现方向选择时给，最多 3 个；' +
    '没有合适的岔路就给空数组 []。'
  ].join('\n');

  /* ------------------------ 故事规划 ------------------------ */
  /* 只在有零章时用。产出章节计划（title + brief），落库为 planned 章。 */
  function buildOutline(work) {
    var sys = [
      '你在为一部私人剧本规划章节。这部作品：',
      realityBlock(work), userPosBlock(work), materialBlock(work),
      castBlock(work), timeBlock(work),
      '【输出】只输出一个 JSON 对象：{"chapters":[{"title":"章节名","brief":"两三句话，这一章写什么"}]}' +
        '。章数 3~8；只规划、不写正文；章节按故事顺序排列，第一章要能把读者带进这个世界。'
    ].filter(Boolean).join('\n\n');
    return [
      { role: 'system', content: sys },
      { role: 'user', content: '作品名《' + (work.title || '未命名') + '》' +
        (work.desc ? '：' + work.desc : '') +
        (work.wish ? '。读者的愿望：' + work.wish : '') +
        '。请规划章节。' }
    ];
  }

  function parseOutline(raw) {
    var obj = parseJSON(raw);
    if (!obj || !Array.isArray(obj.chapters)) return { ok: false, chapters: [] };
    var list = obj.chapters.filter(function (c) {
      return c && typeof c.title === 'string' && c.title.trim();
    }).map(function (c) {
      return { title: String(c.title).trim().slice(0, 40),
        brief: typeof c.brief === 'string' ? c.brief.trim().slice(0, 300) : '' };
    }).slice(0, 8);
    return { ok: list.length > 0, chapters: list };
  }

  /* ------------------------ 正文生成 ------------------------ */
  function buildChapter(work, chapter, opts) {
    opts = opts || {};
    var tail = chapterTail(work, chapter);
    var sys = [
      '你在续写一部私人剧本。请写出《' + (work.title || '未命名') + '》的「' +
        (chapter.title || '本章') + '」整章正文。',
      realityBlock(work), userPosBlock(work), materialBlock(work),
      castBlock(work), timeBlock(work),
      styleBlock(work), rulesBlock(work), WRITING, OUTPUT_PROTO
    ].filter(Boolean).join('\n\n');

    var user = [];
    if (opts.branchNote) {
      user.push('上一章末尾读者选了岔路「' + opts.branchNote + '」，本章沿这条路写。');
    }
    if ((work.chapters || []).length > 1) {
      user.push('全书前情（最后部分）：\n' + tail);
    }
    if (chapter.brief) user.push('本章概要：' + chapter.brief);
    if (chapter.directorNote) user.push('作者手记（本章的额外意图，优先遵守）：' + chapter.directorNote);
    user.push('现在写出整章正文。' + lengthBlock(work));

    return [
      { role: 'system', content: sys },
      { role: 'user', content: user.filter(Boolean).join('\n\n') }
    ];
  }

  /* 前情：从**已写完**的章节里取最后 400 字。只用 prose/dialogue/text，
    译文与排版标记都不进（与 parasToLines 同一条纪律）。 */
  function chapterTail(work, chapter) {
    var acc = '';
    var chs = (work && work.chapters) || [];
    for (var i = 0; i < chs.length && acc.length < 400; i++) {
      if (chs[i].id === chapter.id) continue;
      if (chs[i].status !== 'ready') continue;
      var texts = (chs[i].paras || []).filter(function (p) {
        return p.kind !== 'scene_break';
      }).map(function (p) { return p.text || ''; });
      acc += texts.join('\n') + '\n';
    }
    return acc.slice(-400);
  }

  function parseChapter(raw) {
    var obj = parseJSON(raw);
    if (!obj || !Array.isArray(obj.paras)) return { ok: false, paras: [], choices: [] };
    var paras = obj.paras.filter(function (p) {
      if (!p || typeof p.text !== 'string') return false;
      /* scene_break 允许空 text（协议里就是这么要求的），其它类型必须有正文 */
      if (p.type === 'scene_break') return true;
      return !!p.text.trim();
    }).map(function (p) {
      var t = ['prose', 'dialogue', 'memory', 'aside', 'scene_break'].indexOf(p.type) >= 0
        ? p.type : 'prose';
      return { kind: t, text: String(p.text).trim() };
    });
    if (!paras.length) return { ok: false, paras: [], choices: [] };
    var choices = (Array.isArray(obj.choices) ? obj.choices : []).filter(function (c) {
      return c && typeof c.label === 'string' && c.label.trim();
    }).map(function (c) {
      return { label: String(c.label).trim().slice(0, 24),
        hint: typeof c.hint === 'string' ? c.hint.trim().slice(0, 60) : '' };
    }).slice(0, 3);
    return { ok: true, paras: paras, choices: choices };
  }

  /* ------------------------ 局部重写 ------------------------ */
  /* 重写只动一段：给原文、上下文邻段与重写说明；输出是**纯文本**，
     不是 JSON —— 一段散文不需要协议。 */
  function buildRewrite(work, chapter, para, note) {
    var paras = (chapter.paras || []);
    var idx = -1;
    for (var i = 0; i < paras.length; i++) if (paras[i].id === para.id) { idx = i; break; }
    var prev = idx > 0 ? paras[idx - 1] : null;
    var next = idx >= 0 && idx < paras.length - 1 ? paras[idx + 1] : null;
    function brief(p) {
      if (!p) return '';
      return (p.kind === 'scene_break' ? '（场景转换）' : (p.text || '').slice(0, 120));
    }
    var sys = [
      '你在为一部私人剧本重写**一段**正文。只改这一段，其它的一个字都不动。',
      styleBlock(work), rulesBlock(work), WRITING,
      '【输出】只输出重写后的这一段正文本身：不要解释、不要引号、不要 JSON、不要标题。'
    ].filter(Boolean).join('\n\n');
    var user = [
      prev ? '上一段（衔接用，不许改动它）：' + brief(prev) : '',
      '【要重写的这一段·原文】\n' + (para.text || ''),
      next ? '下一段（衔接用，不许改动它）：' + brief(next) : '',
      '【重写说明】' + (note || '保持原意，换一种更好的写法。'),
      '现在输出重写后的这一段。'
    ].filter(Boolean).join('\n\n');
    return [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ];
  }

  /* ------------------------ 共用解析 ------------------------ */
  function parseJSON(raw) {
    var text = String(raw || '').trim();
    var m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (m) text = m[1].trim();
    var i = text.indexOf('{');
    var j = text.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(text.slice(i, j + 1)); } catch (e) { return null; }
  }

  /* ---------------------------- 出口 ---------------------------- */

  Sleepy.wjPrompt = {
    buildOutline: buildOutline, parseOutline: parseOutline,
    buildChapter: buildChapter, parseChapter: parseChapter,
    buildRewrite: buildRewrite
  };

})(window);
