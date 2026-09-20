/* ============================================================
   wj-check.js — 帷境 · 五层八股检查器（T4 · 本地引擎，0 API）
   依赖：wj-data.js（词表与作品数据）
   被依赖：page-wj-work.js（成稿检查面板）、后续 T4 文风引擎

   依据《帷境总纲 v1》§9.4 五层八股拦截：
     1. 明确禁用项；
     2. 高频词、动作、身体部位与意象密度；
     3. 换词不换骨架的句式模板；
     4. 环境—动作—心理总结等段落模板；
     5. 人物与情感逻辑失真（最高优先级）。

   ★ 三条铁律（改之前先读）：
   1. **检查无权静默重写全文**（总纲 §14）—— 这里只产出问题报告，
      重写一律由用户在面板/阅读页里逐段点出来（走 wj-engine.rewritePara）；
   2. **规则必须原创**（总纲 §9.5）—— 下面所有词表与描述都是本项目
      自己写的，不许抄旧卡片或外部提示词的具体措辞；
   3. 用户确认过的雷区才参与检查（confirmed !== false）；
      候选规则没有生效资格。

   第五层（人物逻辑）本地只能做**代理检查**：能抓「用动作替代回应 /
   自动定性 user」这类可枚举的失真，抓不了动机与知情范围 —— 面板上
   要如实标注「代理检查」，别装作它判得了逻辑。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* ------------------------- 内置检查规则 -------------------------
     全部原创措辞。pattern 是正则来源字符串；hit 满三层之一：
     layer（五层之一）/ rule（给用户看的问题类型）/ hint（重写建议）。 */
  var BUILTIN = [
    /* —— 第一层 · 明确禁用 —— */
    { layer: 'banned', rule: '用括号书写动作或内心',
      pattern: '（[^（）]{0,14}(笑|哭|叹|低头|抬头|轻声|低声|内心|心想|喘|顿住|停顿)[^（）]{0,8}）',
      hint: '动作与心理写进叙述本身，不用括号钉住。' },
    { layer: 'banned', rule: '套话式微妙描写',
      pattern: '不易察觉|几不可(闻|察)|眼底(闪过|掠过)一[丝瞬抹]|眸[色光](沉了|暗了|深了)|声音低了[几两三]分|空气仿佛凝固',
      hint: '换成这个人自己会有的具体动作与感官，不用通用的微妙套话。' },
    { layer: 'banned', rule: '意味深长收尾',
      pattern: '[。…”"]{0,2}(没有人知道|没有人回答|谁也没有说话)[。"？？”]?$',
      hint: '让场景自己停在动作或声音上，不用「无人应答」压尾。' },

    /* —— 第二层 · 高频密度 —— */
    { layer: 'density', rule: '同一意象密度过高',
      pattern: null,   /* 由 densityCheck 按词表计数，不走正则 */
      hint: '同一身体部位或意象在短距离里反复出现，删掉大半，留一处最重的。' },

    /* —— 第三层 · 句式模板 —— */
    { layer: 'template', rule: '比喻收尾连用',
      pattern: '(像是?[^。]{2,18}|仿佛[^。]{2,18})[。…”"]\\s*$',
      hint: '连续几段都用「像/仿佛」收束，段落骨架就重复了；留一处，其余直说。' },
    { layer: 'template', rule: '段首同字连开',
      pattern: null,   /* openerCheck：连续 ≥3 段同一字开头 */
      hint: '几段连着用同一个字起头，读起来像排比模板；换一两个段落的切入角度。' },

    /* —— 第四层 · 段落模板 —— */
    { layer: 'pgraph', rule: '抽象总结替代情节',
      pattern: '(似乎在诉说|仿佛在(告诉|说)|某种难以言[喻说]|说不清道不明|无法言说的)',
      hint: '总结感受不如给出下一件发生的事；把抽象句换成具体动静。' },
    { layer: 'pgraph', rule: '空转的氛围句',
      pattern: '(时间(仿佛|好像)?(静止|停住了)|世界安静得|空气安静得)',
      hint: '氛围靠具体物与动静立起来，不靠「时间静止」这类空转句。' },

    /* —— 第五层 · 人物逻辑（代理检查） —— */
    { layer: 'logic', rule: '动作替代真正的回应',
      pattern: '(揉了?揉[^。]{0,4}头发|摸了摸[^。]{0,4}头|递过(一?杯|一?瓶)|把水(递|塞)到|劝[^。]{0,2}睡)',
      hint: '先给出真实的回应内容，动作只是伴随；不能拿摸头递水顶替说话。' },
    { layer: 'logic', rule: '疑似自动定性 user',
      pattern: '(嘴硬|逞强|口是心非|故意试探|闹脾气|撒娇)',
      hint: 'user 的内心只能由 user 确认；不确定时让人物去问或停在观察。' }
  ];

  /* 第二层用的意象词表（原创，身体部位 + 高频意象家族） */
  var DENSITY_WORDS = ['指尖', '指节', '睫毛', '喉结', '眸', '眼底', '心脏',
    '胸腔', '呼吸', '耳廓', '手腕', '风', '潮', '灯影', '雾', '雪'];

  /* ------------------------- 工具 ------------------------- */

  function activeRules(work) {
    var cfg = Sleepy.wj.styleCfg();
    var out = [];
    /* 只有确认过的全局规则参与本地检查；候选（confirmed:false）没有资格 */
    (cfg.globalRules || []).forEach(function (r) {
      if (r && r.text && r.confirmed !== false) out.push(r);
    });
    return out;
  }

  function escRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function issue(ch, para, it) {
    return {
      chapterId: ch.id, chapterTitle: ch.title,
      paraId: para.id, paraNo: para.no,
      layer: it.layer, rule: it.rule,
      excerpt: (para.text || '').slice(0, 42),
      hint: it.hint
    };
  }

  /* 五层顺序即优先级（人物逻辑最后列但权重最高，面板置顶展示） */
  var LAYER_ORDER = ['logic', 'banned', 'density', 'template', 'pgraph'];

  var LAYERS = [
    { id: 'logic', name: '人物逻辑', note: '代理检查：可枚举的失真' },
    { id: 'banned', name: '明确禁用', note: '雷区与套话' },
    { id: 'density', name: '高频密度', note: '意象与身体部位' },
    { id: 'template', name: '句式模板', note: '换词不换骨架' },
    { id: 'pgraph', name: '段落模板', note: '总结替代情节' }
  ];

  /* ------------------------- 逐段检查 ------------------------- */

  function checkChapter(work, ch) {
    var issues = [];
    var paras = (ch.paras || []).filter(function (p) {
      return p.kind !== 'scene_break' && (p.text || '').trim();
    });
    if (!paras.length) return issues;

    /* 用户确认过的雷区词（全局 + 本篇），做字面命中 */
    var userRules = activeRules(work).concat((work.workRules || []).filter(function (r) {
      return r && r.text && r.confirmed !== false;
    }));
    var userRe = userRules.map(function (r) { return escRe(r.text.slice(0, 24)); })
      .join('|');
    var userPattern = userRe ? new RegExp(userRe) : null;

    paras.forEach(function (p) {
      var text = p.text || '';
      BUILTIN.forEach(function (it) {
        if (!it.pattern) return;
        var re = new RegExp(it.pattern);
        if (re.test(text)) issues.push(issue(ch, p, it));
      });
      if (userPattern && userPattern.test(text)) {
        /* 命中用户雷区：不区分是哪一条（可能多条），给出统一提示 */
        issues.push(issue(ch, p, {
          layer: 'banned', rule: '命中你的雷区',
          hint: '这段踩到了你定下的表达禁区；按雷区强度处理，重写时避开同类写法。'
        }));
      }
    });

    issues = issues.concat(densityCheck(ch, paras),
      openerCheck(ch, paras), tailSimileCheck(ch, paras));

    /* 按五层优先级稳定排序，同层按段落序 */
    issues.sort(function (a, b) {
      var la = LAYER_ORDER.indexOf(a.layer), lb = LAYER_ORDER.indexOf(b.layer);
      if (la !== lb) return la - lb;
      return a.paraNo - b.paraNo;
    });
    return issues;
  }

  /* 第二层：意象词密度（总数 ≥5 且每 400 字 ≥1 次，短章不报） */
  function densityCheck(ch, paras) {
    var issues = [];
    var total = paras.reduce(function (n, p) { return n + (p.text || '').length; }, 0);
    if (total < 300) return issues;
    DENSITY_WORDS.forEach(function (w) {
      var n = 0, first = null;
      paras.forEach(function (p) {
        var cnt = (p.text || '').split(w).length - 1;
        n += cnt;
        if (cnt && !first) first = p;
      });
      if (n >= 5 && n * 400 >= total) {
        issues.push(issue(ch, first, {
          layer: 'density',
          rule: '「' + w + '」出现 ' + n + ' 次',
          hint: '同一意象密度过高；整章留一两处最重的，其余换具体的物与动作。'
        }));
      }
    });
    return issues;
  }

  /* 第三层：连续 ≥3 段同一字开头 */
  function openerCheck(ch, paras) {
    var issues = [];
    var run = 1;
    for (var i = 1; i < paras.length; i++) {
      var prev = (paras[i - 1].text || '').trim().charAt(0);
      var cur = (paras[i].text || '').trim().charAt(0);
      if (cur && cur === prev) {
        run++;
        if (run === 3) {
          issues.push(issue(ch, paras[i], {
            layer: 'template', rule: '连续 ' + run + ' 段用「' + cur + '」开头',
            hint: '换一两个段落的切入角度，别让段落起手长成排比。'
          }));
        } else if (run > 3) {
          issues[issues.length - 1].rule = '连续 ' + run + ' 段用「' + cur + '」开头';
        }
      } else {
        run = 1;
      }
    }
    return issues;
  }

  /* 第三层：连续 ≥3 段用「像/仿佛」收尾 */
  function tailSimileCheck(ch, paras) {
    var issues = [];
    var re = /(像是?[^。]{2,18}|仿佛[^。]{2,18})[。…”"]\s*$/;
    var run = 0, last = null;
    paras.forEach(function (p) {
      if (re.test((p.text || '').trim())) {
        run++; last = p;
      } else {
        if (run >= 3) {
          issues.push(issue(ch, last, {
            layer: 'template', rule: '连续 ' + run + ' 段用比喻收尾',
            hint: '留一处比喻就够，其余直接说事。'
          }));
        }
        run = 0;
      }
    });
    if (run >= 3) {
      issues.push(issue(ch, last, {
        layer: 'template', rule: '连续 ' + run + ' 段用比喻收尾',
        hint: '留一处比喻就够，其余直接说事。'
      }));
    }
    return issues;
  }

  /* --------------------- 跨章风格漂移检查 --------------------- */
  /* 每章两个可量化的口径：平均段长 / 对白占比。相邻章突变就提醒。
     只给证据和数字，判断权在 user（总纲 §14）。 */
  function drift(work) {
    var rows = [];
    (work.chapters || []).forEach(function (ch) {
      if (ch.status !== 'ready') return;
      var paras = (ch.paras || []).filter(function (p) { return p.kind !== 'scene_break'; });
      if (!paras.length) return;
      var total = paras.reduce(function (n, p) { return n + (p.text || '').length; }, 0);
      var dlg = paras.filter(function (p) { return p.kind === 'dialogue'; })
        .reduce(function (n, p) { return n + (p.text || '').length; }, 0);
      rows.push({
        chapterId: ch.id, title: ch.title,
        paras: paras.length,
        avgLen: Math.round(total / paras.length),
        dialogueRatio: total ? Math.round(dlg / total * 100) : 0
      });
    });
    var notes = [];
    for (var i = 1; i < rows.length; i++) {
      var a = rows[i - 1], b = rows[i];
      var lenDelta = a.avgLen ? Math.abs(b.avgLen - a.avgLen) / a.avgLen : 0;
      var dlgDelta = Math.abs(b.dialogueRatio - a.dialogueRatio);
      if (lenDelta > 0.6) {
        notes.push('「' + b.title + '」平均段长比上一章突变 ' +
          Math.round(lenDelta * 100) + '%（' + a.avgLen + ' → ' + b.avgLen + ' 字/段）。');
      }
      if (dlgDelta > 25) {
        notes.push('「' + b.title + '」对白占比从 ' + a.dialogueRatio + '% 变到 ' +
          b.dialogueRatio + '%，和文风台定下的口径可能不一致。');
      }
    }
    return { rows: rows, notes: notes };
  }

  /* --------------------- 人物声音差异检查 --------------------- */
  /* 台词归属：对白段的前 20 字里能认出的出场人物名。只统计与提醒，
     不打分 —— 「同一个人跨章是同一种声音」最终靠 user 读。 */
  function voices(work) {
    var cast = (work.cast || []).map(function (x) { return x.name; });
    var byName = {};
    cast.forEach(function (n) {
      byName[n] = { name: n, lines: 0, totalLen: 0, openers: {} };
    });
    (work.chapters || []).forEach(function (ch) {
      if (ch.status !== 'ready') return;
      (ch.paras || []).forEach(function (p) {
        if (p.kind !== 'dialogue' || !p.text) return;
        var head = p.text.slice(0, 20);
        for (var i = 0; i < cast.length; i++) {
          var at = head.indexOf(cast[i]);
          if (at < 0) continue;
          var s = byName[cast[i]];
          s.lines++;
          s.totalLen += p.text.length;
          /* 起手词必须在**剥掉说话人前缀**之后取 —— 对白段开头就写着
             说话人，不剥的话起手永远是名字，趋同提醒会全误报 */
          var rest = p.text.slice(at + cast[i].length)
            .replace(/^[\s：:说说道的，「『""]+/, '');
          var opener = rest.slice(0, 2);
          if (opener) s.openers[opener] = (s.openers[opener] || 0) + 1;
          break;
        }
      });
    });
    var out = cast.map(function (n) {
      var s = byName[n];
      var topOpener = '', topN = 0;
      Object.keys(s.openers).forEach(function (k) {
        if (s.openers[k] > topN) { topN = s.openers[k]; topOpener = k; }
      });
      var remind = '';
      if (s.lines >= 4 && topN / s.lines >= 0.6) {
        remind = '有 ' + Math.round(topN / s.lines * 100) + '% 的台词用「' +
          topOpener + '」起手，人物声音可能趋同。';
      }
      return { name: n, lines: s.lines,
        avgLen: s.lines ? Math.round(s.totalLen / s.lines) : 0, remind: remind };
    });
    return out;
  }

  /* ------------------------- 汇总入口 ------------------------- */

  function all(work) {
    var issues = [];
    (work.chapters || []).forEach(function (ch) {
      if (ch.status !== 'ready') return;
      issues = issues.concat(checkChapter(work, ch));
    });
    return { issues: issues, drift: drift(work), voices: voices(work) };
  }

  /* ---------------------------- 出口 ---------------------------- */

  Sleepy.wjCheck = {
    LAYERS: LAYERS,
    LAYER_ORDER: LAYER_ORDER,
    chapter: checkChapter,
    drift: drift,
    voices: voices,
    all: all
  };

})(window);
