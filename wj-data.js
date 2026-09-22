/* ============================================================
   wj-data.js — 帷境（Veilscape）数据层
   依赖：store.js（存档）、core.js（人物与岛）、calendar.js（时间，惰性取）
   被依赖：page-wj-*.js（全部帷境页面，必须排在它们之前加载）

   为什么单独一层：帷境有 8 个页面要读同一份「剧本」数据，而这一层
   **一次模型调用都不发**（对齐 calendar.js 那条 0 API 红线）——
   生成链在 T3 才接，先让作品的生命周期自己立起来。
   （总纲 §19.2：先让剧本自身活起来，再逐条连外部。）

   ★ 最要紧的一条：段落 id 是**不可变**的（p_<序号>_<8位随机>）。
   共读挂靠、批注、分享段落、局部重写、正史候选来源，六件事全钉在
   它身上；Demo 里那个 p_014 只是**展示序号**，可以重排。
   局部重写只换 text，**绝不换 id**（总纲 §7.3 / 方案 §1.4）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* 一个全局键。**故意不按岛 scoped** —— 群岛作品无法归属单一岛，
     删掉一座岛也不该连坐删掉作品。只有「定史写回现实」那一步才按
     char 所在的岛落库（方案 §5.1）。 */
  var KEY = 'wjWorks';

  /* ---------------------------- 词表 ---------------------------- */

  /* 作品真实性：三档可选 + 一档只读（已定史是审阅后的结果，创建时选不了）。
     用户 2026-09-19 拍板：「普通故事和平行世界都是一定不会有影响，
     正史候选是会有影响的」，并且确认「平行时间线其实就是平行世界」——
     所以时间落点里那一档已经删掉，不再出现。 */
  var REALITY = [
    { id: 'story', name: '普通故事', tone: 'none',
      hint: '只是作品。可自由改写、分支与分享，不进入任何人的现实记忆。' },
    { id: 'parallel', name: '平行世界', tone: 'none',
      hint: '永不写入现实正史，可以自由改变身份与命运。' },
    { id: 'canon_candidate', name: '正史候选', tone: 'wine',
      hint: '发生在角色时间线的空白处；谢幕后仍需逐条审阅、检查冲突，才可能写入。' }
  ];

  var REALITY_LABEL = { story: '普通故事', parallel: '平行世界',
    canon_candidate: '正史候选', canonized: '已定史' };

  /* user 位置：只决定叙事位置，不决定记忆读取权限 */
  var USER_POS = [
    { id: 'actor', name: '作为人物出场' },
    { id: 'observer', name: '只在幕外旁观' },
    { id: 'hidden', name: '完全隐去' }
  ];
  var USER_POS_LABEL = { actor: '作为人物出场', observer: '幕外旁观', hidden: '完全隐去' };

  /* 创作取材：只设置「模型能读到什么」，读到了不等于人物知道作品存在。

     「选择性读取」（select，逐条勾选留痕/时间线）**先收起来了**
     （2026-09-22 用户拍板）：那个勾选器从来没做过，选它实际按 tone 执行。
     留着就是骗人，所以从选项里拿掉；`MATERIAL_LABEL` 里保留 select 的文案，
     老存档（materialScope:'select'）照旧显示与降级执行，不报错。 */
  var MATERIAL = [
    { id: 'none', name: '不读取', hint: '只使用基础人设与本篇临时设定。' },
    { id: 'tone', name: '只读关系与性格底色', hint: '知道人物如何思考与相处，不调用具体共同事件。' },
    { id: 'world', name: '读取当前世界资料', hint: '高度贴合现有生活；仍不会让角色知道作品存在。' }
  ];
  var MATERIAL_LABEL = { none: '不读取', tone: '只读关系与性格底色',
    select: '选择性读取（已收起）', world: '读取当前世界资料' };

  /* 时间落点：只管「取哪一段空白」。（「平行时间线」已删 —— 那是真实性的事） */
  var TIME_ANCHOR = [
    { id: 'before_known', name: '已知过去之前', hint: '早年经历；需要特别检查年龄与家庭关系。' },
    { id: 'before_user', name: '认识 user 以前', hint: '角色已有独立生活，但尚未与 user 建立关系。' },
    { id: 'gap', name: '两段经历之间', hint: '填补现有时间线中的一处空白。' }
  ];
  var TIME_ANCHOR_LABEL = { before_known: '已知过去之前', before_user: '认识 user 以前',
    gap: '两段经历之间', parallel: '与既有时间线无关' };

  var POV = ['跟随主视角', '第三人称多视角', '双线交替'];
  var LENGTH = ['短篇', '中篇', '长篇'];

  /* ---------------------- 文风底座（六套） ----------------------
     用户 2026-09-19 拍板：**用文风设置台那套**，废弃创建流程 Demo 里
     「月下私语 / 银幕长镜 / 旧梦回声」那一套 —— 它正是总纲 §9.5
     点名要禁的「唯美 / 电影感」类标签（不许拿形容词当实现方案）。

     四个参数是正交的：距离 / 密度 / 节奏 / 对话占比。
     预设只是起点，改过其中任何一根滑杆就转成「自定义」。 */
  var STYLE_PARAMS = [
    { key: 'distance', name: '叙述距离', lo: '贴身', hi: '远景' },
    { key: 'density', name: '语言密度', lo: '稀疏', hi: '丰沛' },
    { key: 'pace', name: '叙事节奏', lo: '停驻', hi: '紧凑' },
    { key: 'dialogue', name: '对话占比', lo: '少对白', hi: '多对白' }
  ];

  var STYLE_PRESETS = {
    '静水': { desc: '克制 · 留白', distance: 62, density: 30, pace: 34, dialogue: 28 },
    '近火': { desc: '贴身 · 慢燃', distance: 24, density: 58, pace: 42, dialogue: 46 },
    '行旅': { desc: '跟随 · 推进', distance: 48, density: 44, pace: 68, dialogue: 40 },
    '群像': { desc: '远景 · 交错', distance: 82, density: 55, pace: 60, dialogue: 57 },
    '冷镜': { desc: '旁观 · 精确', distance: 74, density: 25, pace: 52, dialogue: 32 },
    '夜谈': { desc: '对白 · 潜台词', distance: 38, density: 38, pace: 45, dialogue: 78 }
  };

  /* 雷区四档强度（两处 Demo 一致，直接用） */
  var RULE_STRENGTH = ['永久禁止', '尽量避免', '限制频率', '特定场景允许'];

  /* 出厂全局雷区：全部原创措辞，不引用任何旧卡片或外部作者提示词
     （总纲 §9.5 最后一段）。confirmed:true 表示已生效。 */
  function defaultGlobalRules() {
    return [
      { text: '不用括号固定书写动作、内心或段尾', strength: '永久禁止', confirmed: true },
      { text: '避免用抽象总结替代情节变化', strength: '尽量避免', confirmed: true },
      { text: '不把 user 自动定性为嘴硬、逞强、撒娇或试探', strength: '永久禁止', confirmed: true },
      { text: '不用摸头、拥抱、递水代替真正的回应', strength: '尽量避免', confirmed: true }
    ];
  }

  /* ---------------------------- 工具 ---------------------------- */

  function uid(prefix) {
    return (prefix || 'wj') + '_' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7);
  }

  /* 段落锚点：不可变。前面带上章节序号只是为了人眼好认，**不是**它的身份 ——
     重排章节不会改它，判断相等一律整体比字符串。 */
  function anchorId(chapterSeq) {
    var rnd = Math.random().toString(36).slice(2, 10);
    return 'p_' + String(chapterSeq || 0) + '_' + rnd;
  }

  function nowISO() { return new Date().toISOString(); }

  function read() {
    var list = Sleepy.store.get(KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function write(list) {
    Sleepy.store.set(KEY, list || []);
    if (Sleepy.wj && Sleepy.wj.onChange) Sleepy.wj.onChange();
    return list;
  }

  function all() { return read(); }

  function get(id) {
    var list = read();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 改一部作品：fn 拿到副本随便改，这里负责写回（store.get 是深拷贝，
     改完不 set 回去等于没改 —— 这条坑项目里踩过好几次） */
  function mutate(id, fn) {
    var list = read();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var next = fn(list[i]) || list[i];
      next.updatedAt = nowISO();
      list[i] = next;
      write(list);
      return next;
    }
    return null;
  }

  function remove(id) {
    var list = read().filter(function (w) { return w.id !== id; });
    write(list);
    return true;
  }

  /* ------------------------- 新建一部剧本 -------------------------
     创建流程（T2）调这里落草稿；`status:'draft'` = 未开帷。
     默认值刻意选成 Demo 里那套「最不动现实」的组合：
     普通故事 + 完全隐去 + 不读取。 */
  function defaults() {
    return {
      title: '',
      cover: '',
      desc: '',
      sandboxIds: [],
      cast: [],                 /* [{charId,name,role,identity,isTemp}] */
      userPos: 'observer',
      reality: 'story',
      timeAnchor: 'before_user',
      materialScope: 'tone',
      materialRefs: [],
      styleId: '静水',
      style: null,              /* null = 跟预设；有值 = 自定义后的四参数 */
      wish: '',
      pov: POV[0],
      length: LENGTH[0],
      workRules: [],
      chapters: [],
      stableVersion: 0,
      progress: null,           /* {chapterId, anchorId, percent} */
      status: 'draft',
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
  }

  function createDraft(patch) {
    var list = read();
    var work = defaults();
    if (patch) for (var k in patch) if (patch.hasOwnProperty(k)) work[k] = patch[k];
    if (!work.title) work.title = '未命名剧本';
    /* 文风：开帷这一刻把**全局底座**快照进这一篇（2026-09-22 用户拍板：
       全局是「新作品的起点」，不是活的默认值）。以后改全局只影响新作品 ——
       「我只是调了下滑杆，三个月前那部作品的文风全变了」是最不想看到的。
       用户在开帷里单独调过（patch 带了 style）就不覆盖。 */
    var sc = styleCfg();
    if (!patch || !patch.styleId) work.styleId = sc.preset || work.styleId;
    if (work.style == null) {
      work.style = {
        distance: sc.distance, density: sc.density,
        pace: sc.pace, dialogue: sc.dialogue
      };
    }
    work.id = uid('work');
    list.unshift(work);
    write(list);
    return work;
  }

  /* --------------------------- 章节 / 段落 --------------------------- */

  function seqOf(work, chapterId) {
    var list = (work && work.chapters) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === chapterId) return i + 1;
    return list.length + 1;
  }

  function addChapter(workId, title) {
    return mutate(workId, function (w) {
      w.chapters = w.chapters || [];
      w.chapters.push({
        id: uid('ch'),
        seq: w.chapters.length + 1,
        title: title || ('第' + (w.chapters.length + 1) + '章'),
        status: 'planned',        /* planned | generating | ready | failed */
        paras: [],
        directorNote: ''
      });
      return w;
    });
  }

  function findChapter(work, chapterId) {
    var list = (work && work.chapters) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === chapterId) return list[i];
    return null;
  }

  /* 落一段正文。kind 只是**给程序排版的标记**（prose/dialogue/memory/
     aside/scene_break），不是要求模型把文章写成一句一段
     —— 线下叙事那条定稿说的是「一篇连续的叙事」，这里同理。 */
  function addPara(workId, chapterId, kind, text) {
    return mutate(workId, function (w) {
      var ch = findChapter(w, chapterId);
      if (!ch) return w;
      ch.paras = ch.paras || [];
      ch.paras.push({
        id: anchorId(ch.seq),
        no: ch.paras.length + 1,
        kind: kind || 'prose',
        text: text || '',
        genState: 'done',
        revisions: []
      });
      return w;
    });
  }

  /* 局部重写：**只换 text，id 一个字符都不动**（方案 §1.4）。
     历史留一份修订记录，旧版仍可追溯（总纲 §8.3）。 */
  function rewritePara(workId, chapterId, paraId, nextText) {
    return mutate(workId, function (w) {
      var ch = findChapter(w, chapterId);
      if (!ch || !ch.paras) return w;
      for (var i = 0; i < ch.paras.length; i++) {
        var p = ch.paras[i];
        if (p.id !== paraId) continue;
        p.revisions = p.revisions || [];
        p.revisions.push({ at: nowISO(), from: p.text, to: nextText });
        p.text = nextText;
        p.genState = 'done';
        break;
      }
      return w;
    });
  }

  /* ----------------------------- 统计 ----------------------------- */

  function charCount(work) {
    var n = 0;
    (work && work.chapters || []).forEach(function (ch) {
      (ch.paras || []).forEach(function (p) { n += (p.text || '').length; });
    });
    return n;
  }

  function chapterCount(work, readyOnly) {
    var list = (work && work.chapters) || [];
    if (!readyOnly) return list.length;
    return list.filter(function (c) { return c.status === 'ready'; }).length;
  }

  /* 进度：正式版按「已读锚点 / 总段落」算；现在没有阅读器（T3 才有），
     先按已有正文段落给一个诚实的近似值。 */
  function progressOf(work) {
    var total = 0;
    (work && work.chapters || []).forEach(function (ch) { total += (ch.paras || []).length; });
    if (work && work.progress && work.progress.percent) {
      return { percent: work.progress.percent, total: total };
    }
    return { percent: total ? 100 : 0, total: total };
  }

  /* ------------------------- 门厅要的分组 ------------------------- */

  function shelf(filter) {
    var list = all();
    if (filter === 'recent') {
      return list.slice().sort(function (a, b) {
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
    }
    if (filter === 'unfinished') {
      return list.filter(function (w) { return w.status === 'serializing' || w.status === 'paused'; });
    }
    if (filter === 'completed') {
      return list.filter(function (w) { return w.status === 'completed'; });
    }
    if (filter === 'draft') {
      return list.filter(function (w) { return w.status === 'draft'; });
    }
    return list;
  }

  /* 「继续阅读」只认真的有正文可读的那部（草稿不算，否则点进去是空的） */
  function recentReadable() {
    var list = all().filter(function (w) {
      return w.status !== 'draft' && chapterCount(w, true) > 0;
    });
    list.sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    return list[0] || null;
  }

  function styleOf(work) {
    var id = (work && work.styleId) || '静水';
    var base = STYLE_PRESETS[id] || STYLE_PRESETS['静水'];
    var custom = (work && work.style) || null;
    var params = {
      distance: custom && custom.distance != null ? custom.distance : base.distance,
      density: custom && custom.density != null ? custom.density : base.density,
      pace: custom && custom.pace != null ? custom.pace : base.pace,
      dialogue: custom && custom.dialogue != null ? custom.dialogue : base.dialogue
    };
    /* 「自定义」的判据是**四根滑杆真的和预设不一样**，不是「有没有 style 字段」——
       开帷时会快照一份全局底座进来，那份常常正好等于预设，
       照字段判会把所有作品都标成「自定义」。 */
    var isCustom = STYLE_PARAMS.some(function (p) {
      return params[p.key] !== base[p.key];
    });
    return {
      id: id,
      name: isCustom ? ('自定义（基于' + id + '）') : id,
      desc: isCustom ? '' : base.desc,
      params: params
    };
  }

  function realityOf(work) {
    var id = (work && work.reality) || 'story';
    for (var i = 0; i < REALITY.length; i++) if (REALITY[i].id === id) return REALITY[i];
    return REALITY[0];
  }

  /* ======================== 票根与谢幕（T6） ========================

     票根**全局不 scoped**（方案 §5.1）：群岛作品无法归属单岛，删掉一座岛
     不该连坐删掉票根。所以它**不进 favorites 那张按岛过滤的表** ——
     收藏馆渲染时把两个来源并起来（聊天收藏按岛 + 票根全局）。

     谢幕的另外三路（分享 / 邀请 / 公开）记在 work.curtain 上；
     **票根那一路不进 curtain** —— 它的唯一真相是 wjTickets 里有没有这张，
     记两份迟早对不上。
     ============================================================ */
  var KEY_TICKETS = 'wjTickets';

  function tickets() {
    var list = Sleepy.store.get(KEY_TICKETS, []);
    return Array.isArray(list) ? list : [];
  }

  function ticketFor(workId) {
    var list = tickets();
    for (var i = 0; i < list.length; i++) {
      if (list[i].workId === workId) return list[i];
    }
    return null;
  }

  /* 保存票根。**幂等**：一部作品只有一张 —— 连点两次拿到的是同一张
     （方案 §7 红线 10：有副作用的动作必须幂等）。 */
  function saveTicket(workId) {
    var hit = ticketFor(workId);
    if (hit) return hit;
    var w = get(workId);
    if (!w) return null;
    var list = tickets();
    var t = {
      id: uid('tk'),
      workId: workId,
      title: w.title || '未命名剧本',
      reality: w.reality || 'story',
      chapters: chapterCount(w, true),
      chars: charCount(w),
      cast: (w.cast || []).map(function (c) { return c.name; }),
      at: nowISO()
    };
    list.unshift(t);
    Sleepy.store.set(KEY_TICKETS, list);
    return t;
  }

  function removeTicket(id) {
    var list = tickets().filter(function (t) { return t.id !== id; });
    Sleepy.store.set(KEY_TICKETS, list);
    return true;
  }

  /* 谢幕记账。票根那一路不在这里（见上面那段）。
     **幂等**：已经做过的那一路再点一次原样返回，不刷新时间戳 ——
     否则「重复点一下」会把「什么时候分享的」也一起改掉。

     ⚠️ 这里**不许写 `curtain.at`**：那是「谢幕」本身的时间戳，
     由下面的 curtain() 独占。第一版图省事在这里塞了个 at，
     结果「分享过」被谢幕页当成了「已经谢幕」，谢幕按钮再也不出现
     （真机脚本抓到的）。 */
  var CURTAIN_KEYS = ['shared', 'coreadInvited', 'forumPublished'];

  function curtainOf(work) {
    return (work && work.curtain) || {};
  }

  function markCurtain(workId, key) {
    if (CURTAIN_KEYS.indexOf(key) < 0) return null;
    return mutate(workId, function (w) {
      w.curtain = w.curtain || {};
      if (!w.curtain[key]) w.curtain[key] = nowISO();
      return w;
    });
  }

  /* 谢幕本身：第一次进来把作品标成已完成，并记下谢幕时刻（sealedAt）。
     status 之外什么都不动 —— 「谢幕」不是删除，也不是改权限。 */
  function curtain(workId) {
    return mutate(workId, function (w) {
      w.curtain = w.curtain || {};
      if (!w.curtain.sealedAt) w.curtain.sealedAt = nowISO();
      if (w.status !== 'completed') w.status = 'completed';
      return w;
    });
  }
  function isSealed(work) { return !!curtainOf(work).sealedAt; }

  /* ---------------------- 全局文风配置（跨作品） ---------------------- */
  var KEY_CFG = 'wjStyleCfg';

  function styleCfg() {
    var c = Sleepy.store.get(KEY_CFG, null);
    if (!c || !c.globalRules) {
      return { preset: '静水', scope: 'global', globalRules: defaultGlobalRules(),
        distance: STYLE_PRESETS['静水'].distance,
        density: STYLE_PRESETS['静水'].density,
        pace: STYLE_PRESETS['静水'].pace,
        dialogue: STYLE_PRESETS['静水'].dialogue };
    }
    return c;
  }

  function saveStyleCfg(patch) {
    var c = styleCfg();
    for (var k in patch) if (patch.hasOwnProperty(k)) c[k] = patch[k];
    Sleepy.store.set(KEY_CFG, c);
    return c;
  }

  /* ---------------------------- 出口 ---------------------------- */

  Sleepy.wj = {
    KEY: KEY,
    REALITY: REALITY, REALITY_LABEL: REALITY_LABEL,
    USER_POS: USER_POS, USER_POS_LABEL: USER_POS_LABEL,
    MATERIAL: MATERIAL, MATERIAL_LABEL: MATERIAL_LABEL,
    TIME_ANCHOR: TIME_ANCHOR, TIME_ANCHOR_LABEL: TIME_ANCHOR_LABEL,
    POV: POV, LENGTH: LENGTH,
    STYLE_PARAMS: STYLE_PARAMS, STYLE_PRESETS: STYLE_PRESETS,
    RULE_STRENGTH: RULE_STRENGTH,

    uid: uid, anchorId: anchorId, nowISO: nowISO,
    all: all, get: get, mutate: mutate, remove: remove,
    createDraft: createDraft, defaults: defaults,
    addChapter: addChapter, findChapter: findChapter, seqOf: seqOf,
    addPara: addPara, rewritePara: rewritePara,
    charCount: charCount, chapterCount: chapterCount, progressOf: progressOf,
    shelf: shelf, recentReadable: recentReadable,
    styleOf: styleOf, realityOf: realityOf,
    styleCfg: styleCfg, saveStyleCfg: saveStyleCfg,
    /* 票根与谢幕（T6） */
    KEY_TICKETS: KEY_TICKETS, CURTAIN_KEYS: CURTAIN_KEYS,
    tickets: tickets, ticketFor: ticketFor,
    saveTicket: saveTicket, removeTicket: removeTicket,
    curtainOf: curtainOf, markCurtain: markCurtain, curtain: curtain,
    isSealed: isSealed,
    onChange: null
  };

})(window);
