/* ============================================================
   page-idcard.js — 名片夹（全局后台造物主）
   依赖：store.js、core.js、ui.js、app.js
   页面：contacts（树状列表）→ contact-edit（编辑）
         → contact-bind（绑定 User 马甲 / 认知矩阵）
         → contact-group（群聊）
         → mask-edit（User 马甲编辑）

   ---- 它到底是什么（《聊天 App》骨架第 1 节）----
   名片夹不在聊天 App 内，它是全局的「捏人台」与数据库。保持极简：
     1. 建 Char：创建核心大角色，挂载专属世界书。
     2. 马甲 Tab：在一个 Char 面板内分 Tab 管理他的不同身份（大号/小号）。
        底层共享同一个大脑，但每个皮套有独立的头像、昵称和表面设定。

   ---- 树状层级（《终极架构总纲》第 2 节）----
   放弃扁平的联系人列表，改成：
     大号 Char A ──┬── 皮套 Char a
                   ├── 皮套 Char a2
                   └── NPC 1
   皮套对外展示不同的设定和 UI 皮肤，但**底层与大号同源**
   （记忆/大脑挂在根节点上，见 core.js 的 rootOf）。

   ---- 双向掉马矩阵（《聊天 App》「初始状态矩阵」）----
   在通讯录建立联系的初始，由 User 决定双方的认知状态。
   三种场景（A:1C2U / B:1U2C / C:2U2C）的六个状态，
   在代码里其实就是两个布尔维度的组合，不需要六个分支：
     link.cognition  aware / unaware
     link.barrier    true / false
   界面上给的是「人话标签 + 结果描述」，底层只有这两个值。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var core = Sleepy.core;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var textField = ui.textField;
  var textArea = ui.textArea;
  var button = ui.button;
  var downloadText = ui.downloadText;
  var pickTextFile = ui.pickTextFile;

  var SVG_ICON = 'viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"';

  var ICON_IMPORT = '<svg ' + SVG_ICON + '><path d="M12 4v11"/><path d="M8 11l4 4 4-4"/>' +
    '<path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/></svg>';
  var ICON_EXPORT = '<svg ' + SVG_ICON + '><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/>' +
    '<path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/></svg>';

  /* 分隔头。宽松一点：等号三个以上、冒号中英文都认。
     v2（2026-09-21）：皮套 / NPC 也算头 —— 以前只认「角色/预设」，
     导出文件里的「===== 皮套：x | 属于：y =====」导回去会整行掉进正文，
     层级全丢。「属于：」后缀记的是层级（v2 新增「岛：岛名」给岛级 NPC）。 */
  var HEAD_RE = /^={3,}\s*(角色|皮套|NPC|预设)\s*[：:]\s*(.+?)\s*={3,}$/;
  var PARENT_MARK = ' | 属于：';

  /* 头像字段：网址输入 ＋ 本地图选择（2026-09-21 补齐「缺的那一环」）。
     本地图进图库（IndexedDB，media.js），记录里只存 mediaId（avatarMedia）——
     base64 塞 localStorage 的老路早废弃了。网址与本地图可并存，显示时本地图优先
     （core.avatarSrc 的口径）。三个头像字段（简化表单 / 完整表单 / 马甲编辑）共用。
     用法：f.avatar = avatarFieldLocal(existing, {toast}); 保存时取
     f.avatar.get()（网址）+ f.avatar.getMedia()（mediaId）。 */
  function avatarFieldLocal(existing, opts) {
    opts = opts || {};
    var toast = opts.toast || function () {};
    var f = textField({
      label: opts.label || '头像地址',
      hint: '留空就用名字首字。贴图片网址，或在下面选一张本地图',
      value: existing ? (existing.avatar || '') : '',
      placeholder: 'https://…',
      inputmode: 'url'
    });
    var mediaId = (existing && existing.avatarMedia) || '';

    var file = h('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.style.display = 'none';

    var state = h('span', 'av-local-state');
    var clearBtn = button('移除本地图', 'ghost', function () {
      mediaId = '';
      clearBtn.style.display = 'none';
      state.textContent = '已移除，保存后用网址或首字头像';
    });
    clearBtn.style.display = mediaId ? '' : 'none';
    function paintState() {
      state.textContent = mediaId ? '已选本地图（保存后生效）' : '';
    }
    paintState();

    file.addEventListener('change', function () {
      var picked = file.files && file.files[0];
      file.value = '';
      if (!picked) return;
      if (!Sleepy.media || !Sleepy.media.shrink || !Sleepy.media.put) {
        toast('图库没就绪，选不了本地图', 'err');
        return;
      }
      toast('正在处理图片…');
      Sleepy.media.shrink(picked, 320).then(function (r) {
        return Sleepy.media.put(r.blob, { name: '头像', kind: 'avatar', w: r.w, h: r.h });
      }).then(function (mid) {
        mediaId = mid;
        clearBtn.style.display = '';
        paintState();
        toast('选好了，别忘了保存', 'ok');
      }, function () {
        toast('这张图读不出来', 'err');
      });
    });

    var pickBtn = button('选本地图', 'ghost', function () { file.click(); });
    var actions = h('div', 'btn-row av-local');
    actions.appendChild(pickBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(state);
    f.el.appendChild(actions);
    f.el.appendChild(file);

    f.getMedia = function () { return mediaId; };
    return f;
  }

  /* 头像框（点框换图）—— 给编辑页的同学录排版用。
     跟 avatarFieldLocal 的差别：那边是「地址输入框 + 选本地图」两件控件、
     每个都是一条框；这边只有**一个方头像**，点框 = 选本地图，
     框下一行小字 = 贴网址 / 移除。
     存的口子完全一样（avatar 字符串 + avatarMedia 的 mediaId），
     所以 doSave 那边不用改。 */
  function faceField(existing, opts) {
    opts = opts || {};
    var toast = opts.toast || function () {};
    var mediaId = (existing && existing.avatarMedia) || '';
    var url = existing ? (existing.avatar || '') : '';
    /* 首字：opts.initial 优先（user 侧要按「名字留空退微信名」取，见 core.initialOfUser），
       否则按名字首字，再否则 empty（新建时那个 ＋）。 */
    var initial = opts.initial
      || ((existing && existing.name) ? existing.name.charAt(0) : (opts.empty || '＋'));

    var wrap = h('div', 'face-field');
    var box = h('button', 'face-box');
    box.type = 'button';
    box.title = '点一下换一张本地图';

    function paintBox() {
      box.textContent = initial;
      box.classList.remove('has-img');
      box.style.backgroundImage = '';
      if (url || mediaId) core.setAvatarBg(box, { avatar: url, avatarMedia: mediaId });
    }

    var file = h('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.style.display = 'none';

    file.addEventListener('change', function () {
      var picked = file.files && file.files[0];
      file.value = '';
      if (!picked) return;
      if (!Sleepy.media || !Sleepy.media.shrink || !Sleepy.media.put) {
        toast('图库没就绪，选不了本地图', 'err');
        return;
      }
      toast('正在处理图片…');
      Sleepy.media.shrink(picked, 320).then(function (r) {
        return Sleepy.media.put(r.blob, { name: '头像', kind: 'avatar', w: r.w, h: r.h });
      }).then(function (mid) {
        mediaId = mid;
        url = '';
        paintBox();
        repaintActs();
        toast('选好了，别忘了保存', 'ok');
      }, function () {
        toast('这张图读不出来', 'err');
      });
    });

    box.addEventListener('click', function () { file.click(); });

    /* 框下面那行小字：贴网址 / 移除。占位不占版面 —— 用户嫌「圆角框太多」，
       所以这两件事做成无框的文字按钮。 */
    var acts = h('div', 'face-acts');
    function repaintActs() {
      acts.innerHTML = '';
      var urlBtn = h('button', 'face-act', '贴网址');
      urlBtn.type = 'button';
      urlBtn.addEventListener('click', async function () {
        var v = await ui.prompt({
          title: '头像网址',
          note: '留空就用名字首字',
          value: url,
          ok: '用它'
        });
        if (v === null) return;
        url = String(v).trim();
        mediaId = '';
        paintBox();
        repaintActs();
      });
      acts.appendChild(urlBtn);

      if (mediaId) {
        var rm = h('button', 'face-act', '移除');
        rm.type = 'button';
        rm.addEventListener('click', function () {
          mediaId = '';
          paintBox();
          repaintActs();
        });
        acts.appendChild(rm);
      }
    }
    repaintActs();

    wrap.appendChild(box);
    wrap.appendChild(acts);
    wrap.appendChild(file);
    paintBox();

    return {
      el: wrap,
      get: function () { return url; },
      getMedia: function () { return mediaId; },
      setName: function (n) {
        if (existing && existing.avatarMedia) return;   /* 有图就别动首字 */
        initial = (n && String(n).trim()) ? String(n).trim().charAt(0)
          : (opts.initial || opts.empty || '＋');
        paintBox();
      }
    };
  }

  /* ------------------------- 导出 / 解析 ------------------------- */

  function toFileText(items) {
    var out = '';
    items.forEach(function (it) {
      out += '===== 角色：' + it.name + ' =====\n' + (it.content || '') + '\n';
    });
    return out;
  }

  function parseFileText(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    var blocks = [];
    var cur = null;
    lines.forEach(function (line) {
      var m = line.match(HEAD_RE);
      if (m) {
        if (cur) blocks.push(cur);
        cur = { kind: m[1], name: m[2], lines: [] };
        return;
      }
      if (cur) cur.lines.push(line);
    });
    if (cur) blocks.push(cur);

    if (!blocks.length) {
      return [{ name: '', content: String(text || '').replace(/\n$/, '') }];
    }
    return blocks.map(function (b) {
      var it = { name: b.name, content: b.lines.join('\n') };
      /* 「皮套：小号 | 属于：本体」→ name=小号，parentName=本体。
         名字里真写了「 | 属于：」的极端情况会被切掉 —— 概率低到不值得防。 */
      var at = it.name.indexOf(PARENT_MARK);
      if (at >= 0) {
        it.parentName = it.name.slice(at + PARENT_MARK.length).trim();
        it.name = it.name.slice(0, at).trim();
      }
      /* kind 归一：角色/预设（A5 旧头）= main，皮套 = sub，NPC = npc。
         岛级 NPC 的头写的是「NPC：某人 | 属于：岛：岛名」，
         parentName 带着就好，归属在 importItems 里统一按岛走。 */
      it.kind = (b.kind === '小号' || b.kind === '皮套') ? 'sub' : (b.kind === 'NPC' ? 'npc' : 'main');
      it.name = it.name.trim();
      return it;
    });
  }

  function nameFromFile(fileName) {
    var n = String(fileName || '').replace(/\.[^.]+$/, '');
    n = n.replace(/^sleepy[-_]?(contacts?|presets?)[-_]?/i, '').replace(/^sleepy[-_]?/i, '');
    return n.trim() || '导入的角色';
  }

  function isJsonish(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return false;
    try { JSON.parse(t); return true; } catch (e) { return false; }
  }

  /* 导入：**永远新建**（2026-09-21 拍板：没有「导入别岛的已有大号」这回事，
     想玩同一个人设就是新建一个新的人，各长各的），导入即打上目标岛的章。
     v2 层级还原：角色=main；皮套挂进**最近一个**大号（导出顺序即层级，
     前面没有大号的皮套当大号收）；NPC 统一**归岛**（唯一口径 core.npcsOfRoom），
     不跟着「属于：某某」挂人 —— 旧文件里那层信息只做展示。
     「导入人设」是往这间房加人的动作，不是往某个总库导数据。 */
  function importItems(items, sandboxId) {
    var list = core.allChars();
    var added = 0;
    /* 建出来的**大号** id —— 调用方（配置台）拿它把导进来的角色放进当前房。
       皮套不进名册（它挂在大号名下），NPC 归岛也不用进。 */
    var ids = [];
    var lastMain = null;

    items.forEach(function (it, i) {
      var kind = it.kind === 'sub' ? 'sub' : (it.kind === 'npc' ? 'npc' : 'main');
      var created = {
        id: core.newId('ch'),
        name: it.name || ('导入的角色 ' + (i + 1)),
        kind: kind,
        parentId: null,
        boundUserId: null,
        sandboxId: sandboxId || null,
        content: it.content,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (kind === 'main') {
        lastMain = created;
        ids.push(created.id);
      } else if (kind === 'sub') {
        if (lastMain) {
          created.parentId = lastMain.id;
          created.parentType = 'char';
        } else {
          /* 文件开头就是皮套 —— 没有本体可挂，当大号收，别让它悬空 */
          created.kind = 'main';
          lastMain = created;
          ids.push(created.id);
        }
      } else {
        created.parentType = 'sandbox';
        created.parentId = sandboxId || null;
      }
      list.push(created);
      added++;
    });

    core.saveChars(list);
    return { added: added, updated: 0, ids: ids };
  }

  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ==================== 名片夹已下线（由浮岛接管） ====================

     原「名片夹（树状列表）」整页删除：它被《小手机 App · 浮岛》取代 ——
     浮岛就是名片夹的进化版，两者不是并存关系。

       高层导航（哪几间房）  →  page-island.js 的 island
       房内捏人（谁在这间房）→  page-island.js 的 island-config
       角色骨架（六字段）    →  本文件的 contact-edit（保留，配置台从它进入）
       群聊 / 马甲           →  contact-group / mask-list（入口改由配置台与 4 Tab 给）

     导入 / 导出没跟着删 —— 它是「往这间房加人」的动作，改由配置台调用
     （见文件末尾的 Sleepy.charIO）。
     ============================================================ */

  function exportAll(ctx) {
    var list = core.mainChars();
    if (!list.length) { ctx.toast('还没有任何角色', 'warn'); return; }

    /* 导出带上层级：大号 + 它的皮套/NPC 一起，「属于：」表示归属。
       这样导出的文件再导回来，树还能立起来（v2：解析侧认皮套/NPC 头）。
       岛级 NPC（parentType='sandbox'，NPC 归岛不归人）单独收在后面，
       用「属于：岛：岛名」标记 —— 导回去还是归岛。 */
    var text = '';
    var exported = {};
    list.forEach(function (m) {
      text += '===== 角色：' + m.name + ' =====\n' + (m.content || '') + '\n';
      exported[m.id] = 1;
      core.subChars(m.id).forEach(function (s) {
        text += '===== 小号：' + s.name + ' | 属于：' + m.name + ' =====\n' + (s.content || '') + '\n';
        exported[s.id] = 1;
      });
      core.npcChars(m.id).forEach(function (s) {
        text += '===== NPC：' + s.name + ' | 属于：' + m.name + ' =====\n' + (s.content || '') + '\n';
        exported[s.id] = 1;
      });
    });
    core.allChars().forEach(function (n) {
      if (n.kind !== 'npc' || (n.parentType || '') !== 'sandbox') return;
      if (exported[n.id]) return;
      var sb = core.findSandbox(n.parentId);
      text += '===== NPC：' + n.name + ' | 属于：岛：' +
        (sb ? (sb.name || '未命名') : '未知') + ' =====\n' + (n.content || '') + '\n';
    });

    var ok = downloadText('sleepy-characters-' + stamp() + '.md', text, 'text/markdown');
    if (ok) ctx.toast('已导出 ' + list.length + ' 个大号（含小号 / NPC）', 'ok');
    else ctx.toast('导出失败：浏览器拦下了下载', 'err');
  }

  /* 导入角色文件。**导入进来的都是新建的角色，直接算这间房的人** ——
     这是配置台的动作（「往这间房加人」），不是全局导数据；
     同名也是新的人（2026-09-21 拍板：各岛各的，分开看）。
     sandboxId 为空时只入库、不进房（留给以后的总库视图用）。 */
  function importInto(ctx, sandboxId) {
    pickTextFile('.txt,.md,.markdown,text/plain,text/markdown', function (text, fileName) {
      if (/\.json$/i.test(fileName) || isJsonish(text)) {
        ctx.toast('这是 json 格式，只收 txt / md 纯文本', 'err');
        return;
      }
      var items = parseFileText(text);
      items = items.filter(function (it) {
        return String(it.content || '').trim() || it.name;
      });
      if (!items.length) { ctx.toast('这个文件里没有内容', 'err'); return; }
      items.forEach(function (it, i) {
        if (!it.name) it.name = items.length === 1 ? nameFromFile(fileName) : ('导入的角色 ' + (i + 1));
      });

      var res = importItems(items, sandboxId);

      /* 把导进来的角色放进这间房（章在 importItems 里已经打了，这里补名册）。
         孤岛只能装一个（这是硬约束，core 会拒），所以先自己判断一下，
         给出人话提示而不是把 core 的报错直接糊到用户脸上。 */
      var note = '';
      if (sandboxId && res.ids && res.ids.length) {
        var sb = core.findSandbox(sandboxId);
        if (sb) {
          if (sb.kind === core.KIND_ISLE && (sb.charIds || []).length >= 1) {
            note = ' · 孤岛已经住着人，导进来的没放进来（想换人的话先把现在的移出）';
          } else {
            var next = (sb.charIds || []).slice();
            var take = sb.kind === core.KIND_ISLE ? res.ids.slice(0, 1) : res.ids;
            take.forEach(function (cid) { if (next.indexOf(cid) < 0) next.push(cid); });
            var r = core.setSandboxChars(sandboxId, next);
            note = r.ok ? ' · 已放进这间房' : (' · ' + r.message);
            if (r.ok && sb.kind === core.KIND_ISLE && res.ids.length > 1) {
              note = ' · 孤岛只收下了第一个，其余留在库里';
            }
          }
        }
      }

      /* 永远新建，没有「覆盖」这回事了 */
      ctx.toast(res.added
        ? '导入完成：新增 ' + res.added + ' 个' + note
        : '导入完成：没变化' + note, 'ok');
      if (ctx.redraw) ctx.redraw();
      else if (ctx.rebuild) ctx.rebuild();
    }, function (msg) {
      ctx.toast(msg || '读取文件失败', 'err');
    });
  }

  /* ==================== 页面：加人设 / 加 NPC ====================

     关系树上所有「+」都进这一页，但**一次只问这一件事**
     （用户原话：「点击加 char 就是只加 char，里面有个可选项是是否有小号，
     有小号就展开设置，没有就关掉那个开关。然后点击 char 下面的加 npc，
     里面就是 npc 的设置」）：

       main  加人设  → 名字 / 头像 / 人设，外加一个「有小号吗」开关；
                      打开才**展开**小号的设置，关着就整个收起来
       sub   加皮套  → 名字 / 头像 / 人设
       npc   加 NPC  → 名字 / 头像 / 人设

     为什么不复用下面那个完整页：完整页是「角色骨架总面板」——
     有身份三选一切换器、所在城市、状态签名、绑定马甲、记忆库。
     从关系树上点一个虚线圆圈加个人却掉进这么一页，会以为走错了地方
     （用户原话：「这个不对呀」「不要这样！！！」）。
     完整页没删，从本页最底下那个入口进。

     归属（挂在谁名下、算皮套还是 NPC）由**点进来的位置**决定，
     通过 params 传进来，这一页不再问。 */
  function renderSimple(ctx, existing, kind, parentId, parentType, sandboxId) {
    var body = ctx.body;
    var isMain = kind === 'main';
    var sb = sandboxId ? core.findSandbox(sandboxId) : null;

    /* 大号名下已有的小号 —— 有的话开关默认就是打开的 */
    var mySub = null;
    if (isMain && existing) {
      var subs = core.subChars(existing.id);
      for (var si = 0; si < subs.length; si++) {
        if (!sb || !subs[si].sandboxId || subs[si].sandboxId === sb.id) {
          mySub = subs[si];
          break;
        }
      }
    }

    ctx.setTitle(existing
      ? (isMain ? '改人设' : (kind === 'sub' ? '改这张脸' : '改这个人'))
      : (isMain ? '加一个人设' : (kind === 'sub' ? '加一个小号' : '加一个 NPC')));

    /* 顶部一句交代「他会落在哪儿」，省得用户自己琢磨 */
    var line;
    if (isMain) {
      if (!sb) {
        line = '他会成为这间房里的人';
      } else if (sb.kind === core.KIND_ISLE) {
        var occupied = !existing && core.charsOfSandbox(sb.id).length >= 1;
        line = occupied
          ? '这座孤岛已经住了人 —— 他还是会被存下来，但进不了这间房'
          : (existing ? '这座孤岛上唯一的那个人'
                      : '孤岛只住得下一个人 · 他会是唯一的那一个');
      } else {
        line = '他会成为这片群岛上的一个人';
      }
    } else {
      var parentIsMe = parentType === 'user';
      var parent = parentIsMe ? core.findUser(parentId) : core.findChar(parentId);
      line = (existing ? '挂在' : '会挂在') + '「' +
        (parent ? parent.name : (parentIsMe ? '我' : '？')) + '」名下 · ' +
        (parentIsMe ? '这是「我」这边的人，跟角色无关'
                    : (kind === 'sub' ? '这是对方的另一张脸' : '这是对方那边的人'));
    }
    /* 他会落在哪儿 —— 一行小字，不再是个圆角说明条
       （用户：「现在的解释太多，圆角框太多」）。 */
    body.appendChild(h('p', 'simple-where', line));

    /* ---- 同学录排版：左边一张头像框，右边两栏（名字 / 微信名）----
       原来是「名字 / 头像地址 / 微信名 / 人设」四段，每段一个圆角输入框、
       每段底下再压一行灰字解释，中间还有分隔线 —— 整页就是一堆框和说明。
       现在：头像交给一个**可以点的方框**（贴网址 / 选本地图都从它进），
       文字栏去框改下划线、不留解释（该说的塞进 placeholder）。 */
    var f = {};
    var form = h('div', 'simple-form');

    var top = h('div', 'face-row');
    f.avatar = faceField(existing, {
      empty: '＋',
      toast: function (t, k) { ctx.toast(t, k); }
    });
    top.appendChild(f.avatar.el);

    var cols = h('div', 'face-cols');
    f.name = textField({
      label: '名字',
      value: existing ? existing.name : '',
      placeholder: 'TA 叫什么'
    });
    /* 头像框里那个首字跟着名字走 —— 打字的时候就能看见 */
    if (f.name.input) {
      f.name.input.addEventListener('input', function () {
        f.avatar.setName(f.name.get());
      });
    }
    cols.appendChild(f.name.el);

    f.wechatName = textField({
      label: '微信名',
      value: existing ? (existing.wechatName || '') : '',
      placeholder: '会话列表里显示的名字 · 可留空'
    });
    cols.appendChild(f.wechatName.el);
    top.appendChild(cols);
    form.appendChild(top);

    f.content = textArea({
      label: '人设',
      value: existing ? existing.content : '',
      rows: 8,
      counter: true,
      placeholder: '是谁、怎么说话、和你什么关系……'
    });
    form.appendChild(f.content.el);

    /* ---- 「有小号吗」开关 + 展开的小号设置 ----
       只有大号才有这个开关：皮套本来就是「大号对外用的另一张脸」，
       NPC 不存在小号这回事。 */
    var sw = null;
    var fs = null;
    var subBox = null;

    if (isMain) {
      sw = ui.switchField({
        label: '有小号吗',
        value: !!mySub
      });
      form.appendChild(sw.el);

      subBox = h('div', 'simple-sub');
      fs = {};
      /* 小号也走同学录那一套（用户：「小号咋没地方加头像，其实也是做成大号的这样」）
         —— 头像是小号这张脸最要紧的东西，原来这里只有名字和人设两个栏。 */
      var subTop = h('div', 'face-row');
      fs.avatar = faceField(mySub, {
        empty: '＋',
        toast: function (t, k) { ctx.toast(t, k); }
      });
      subTop.appendChild(fs.avatar.el);
      var subCols = h('div', 'face-cols');
      fs.name = textField({
        label: '小号的名字',
        value: mySub ? mySub.name : '',
        placeholder: '留空就叫「（大号名）的小号」'
      });
      if (fs.name.input) {
        fs.name.input.addEventListener('input', function () {
          fs.avatar.setName(fs.name.get());
        });
      }
      subCols.appendChild(fs.name.el);
      subTop.appendChild(subCols);
      subBox.appendChild(subTop);
      fs.content = textArea({
        label: '小号人设',
        value: mySub ? mySub.content : '',
        rows: 6,
        counter: true,
        placeholder: '这张脸对外是什么样、别人眼里的他是谁……'
      });
      subBox.appendChild(fs.content.el);
      form.appendChild(subBox);

      subBox.style.display = sw.get() ? '' : 'none';
      sw.input.addEventListener('change', function () {
        subBox.style.display = sw.get() ? '' : 'none';
      });
    }

    body.appendChild(form);

    var btnRow = h('div', 'btn-row');
    btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
    body.appendChild(btnRow);

    if (existing) {
      var more = h('button', 'simple-more', '要更完整的设定（锁脸 / 红线 / 记忆）→');
      more.type = 'button';
      more.addEventListener('click', function () {
        ctx.open('contact-edit', { id: existing.id, sandboxId: sandboxId });
      });
      body.appendChild(more);
    }

    ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

    function doSave() {
      var name = String(f.name.get() || '').trim() || '未命名';
      var payload = {
        id: existing ? existing.id : core.newId('ch'),
        kind: kind,
        parentId: parentId || null,
        name: name,
        wechatName: String(f.wechatName.get() || '').trim(),
        avatar: String(f.avatar.get() || '').trim(),
        avatarMedia: f.avatar.getMedia(),
        content: f.content.get()
      };
      /* 大号、皮套、NPC 都按岛建（2026-09-21 拍板：每岛一份，无全局大号）。
         NPC 归岛（'sandbox'，唯一口径 core.npcsOfRoom）：有房上下文就把
         parentId 一并改写成岛 id（老 NPC 编辑一次就自动迁到新口径）；
         没有房上下文时不动归属字段，免得把老记录改成对不上号的孤儿。 */
      if (kind === 'npc' && sandboxId) {
        payload.parentType = 'sandbox';
        payload.parentId = sandboxId;
      } else if (kind !== 'main') {
        payload.parentType = parentType || 'char';
      }
      if (sandboxId) payload.sandboxId = sandboxId;
      var saved = core.upsertChar(payload);
      if (!saved) { ctx.toast('保存失败', 'err'); return; }

      /* 大号**必须进房**：光建角色、没写进 sandbox.charIds 的话，
         关系树 / 通讯录 / 切号器里全都看不见它（等于白建）。
         这一步以前是漏的 —— 只有 charIO 的导入走 setSandboxChars，
         手工「加人设」建出来的大号是悬空的（房型校验也顺带被绕过了，
         孤岛能悄悄住进第三个人）。 */
      if (isMain && sb) {
        var ids = (sb.charIds || []).slice();
        if (ids.indexOf(saved.id) < 0) {
          var r = core.setSandboxChars(sb.id, ids.concat([saved.id]));
          if (!r.ok) ctx.toast(r.message, 'warn');
        }
      }

      /* 小号：开关关着就**不动**它。
         已有小号不会因为开关被关掉就消失 —— 删角色是破坏性动作，
         不该藏在一个开关的背面。 */
      if (isMain && sw && sw.get()) {
        var subName = String(fs.name.get() || '').trim() || (name + '的小号');
        core.upsertChar({
          id: mySub ? mySub.id : core.newId('ch'),
          kind: 'sub',
          parentId: saved.id,
          parentType: 'char',
          sandboxId: sandboxId || null,
          name: subName,
          avatar: String(fs.avatar.get() || '').trim(),
          avatarMedia: fs.avatar.getMedia(),
          content: fs.content.get()
        });
      }

      ctx.toast('已保存', 'ok');
      ctx.back();
    }
  }

  /* ==================== 页面：编辑角色（含马甲 Tab） ==================== */

  Sleepy.register('contact-edit', {
    title: '角色骨架',
    render: function (ctx) {
      var body = ctx.body;
      var id = ctx.params.id || '';
      var existing = id ? core.findChar(id) : null;

      if (id && !existing) {
        ctx.toast('找不到这个角色', 'err');
        ctx.back();
        return;
      }

      var kind = existing ? (existing.kind || 'main') : (ctx.params.kind || 'main');
      var parentId = existing ? existing.parentId : (ctx.params.parentId || null);

      /* 这间房 —— 配置台带进来的。所有角色都**按房建**（2026-09-21 拍板：
         大号也是每岛一份，没有全局大号），新建时得知道是哪间房，
         否则它不属于任何房、在哪都看不见，拆岛也不会跟着清。 */
      var sandboxId = ctx.params.sandboxId || (existing ? existing.sandboxId : null) || null;

      /* 父亲是「人」还是「角色」。关系树里「我」下面也能挂 NPC，
         所以不能只看 parentId 去猜（两种 id 在不同命名空间）。 */
      var parentType = ctx.params.parentType
        || (existing ? (existing.parentType || 'char') : 'char');

      /* 简化路径：从关系树的虚线位进来的，只问名字 / 头像 / 人设。
         走独立的渲染函数而不是在这里加一堆 if —— 那样两个模式会互相
         污染（改简单页的排版会碰坏完整页）。 */
      if (ctx.params.simple) {
        renderSimple(ctx, existing, kind, parentId, parentType, sandboxId);
        return;
      }

      if (!existing) {
        ctx.setTitle(kind === 'sub' ? '新建小号'
                    : (kind === 'npc' ? '新建 NPC' : '新建大号'));
      }

      /* 整页都用 .simple-form 那一形（下划线字段 + 浅面文本域）——
         用户：「完整页的话头像那些也是和现在这样」。
         **分组卡片保留**：这一页字段多（身份 / 常驻地点 / 绑定马甲 / 人设 /
         锁脸与红线），分门别类本身就是有用的信息架构，拉平反而更难找。 */
      body.classList.add('simple-form');

      var f = {};

      /* ---- 身份 ---- */
      var gKind = group('身份',
        '大号是根，有独立记忆库；小号挂在大号名下，对外是另一张脸，底层同源；' +
        'NPC 属于整座岛 —— 岛上的谁认识 TA，在「岛内成员」里单独定。');

      var kindRow = h('div', 'seg');
      [['main', '大号'], ['sub', '小号'], ['npc', 'NPC']].forEach(function (k) {
        var b = h('button', 'seg-btn' + (kind === k[0] ? ' is-on' : ''), k[1]);
        b.type = 'button';
        /* 已经是皮套的不能再改成大号 —— 它下面可能挂着别的引用 */
        if (existing && (existing.kind || 'main') !== 'main' && k[0] === 'main') b.disabled = true;
        b.addEventListener('click', function () {
          kind = k[0];
          var sib = kindRow.querySelectorAll('.seg-btn');
          for (var i = 0; i < sib.length; i++) sib[i].classList.remove('is-on');
          b.classList.add('is-on');
        });
        kindRow.appendChild(b);
      });
      gKind.card.appendChild(kindRow);

      /* 归属大号：只有皮套需要。NPC 属于整座岛（2026-09-21 拍板），
         不挂任何人名下 —— 保存时自动归当前房。 */
      var parentSel = null;
      if (kind === 'sub') {
        parentSel = h('select', 'set-input set-select');
        core.mainChars().forEach(function (m) {
          if (existing && m.id === existing.id) return;
          var o = h('option', '', m.name);
          o.value = m.id;
          if (m.id === parentId) o.selected = true;
          parentSel.appendChild(o);
        });
        var pw = ui.fieldShell('属于哪个大号', '小号挂在一个大号名下；NPC 属于整座岛，不用选。');
        pw.appendChild(parentSel);
        ui.bindLabel(pw, parentSel);
        gKind.card.appendChild(pw);
      }

      /* 名字 / 头像 / 微信名 = 跟其他加人设入口同一套同学录：
         左头像框（点框选本地图、框下贴网址），右边两栏。 */
      var fRow = h('div', 'face-row');
      f.avatar = faceField(existing, {
        empty: '＋',
        toast: function (t, k) { ctx.toast(t, k); }
      });
      fRow.appendChild(f.avatar.el);
      var fCols = h('div', 'face-cols');
      f.name = textField({
        label: '名字',
        value: existing ? existing.name : '',
        placeholder: '聊天记录里出现的名字'
      });
      if (f.name.input) {
        f.name.input.addEventListener('input', function () {
          f.avatar.setName(f.name.get());
        });
      }
      fCols.appendChild(f.name.el);
      f.wechatName = textField({
        label: '微信名',
        value: existing ? (existing.wechatName || '') : '',
        placeholder: '会话列表里显示的名字 · 可留空'
      });
      fCols.appendChild(f.wechatName.el);
      fRow.appendChild(fCols);
      gKind.card.appendChild(fRow);

      /* `city` 不再放这里 —— 它已经升格成「常驻地点」那一组（见下面 gPlace）。
         原本的 hint 写着「用在桌面的双城时间」，那个组件早撤了。 */
      f.status = textField({
        label: '状态签名',
        hint: '显示在桌面角色卡的第二行（组件商城能装一张角色卡）',
        value: existing ? (existing.status || '') : '',
        placeholder: '开会中…'
      });
      gKind.card.appendChild(f.status.el);

      body.appendChild(gKind.wrap);

      /* ---- 常驻地点（2026-09-19 用户提的）----
         这一个字段喂三个下游：日历用哪国法定节假日、按哪个时区算时间、
         以及以后要做的「说哪国话 / 翻译」。
         所以它挂在 **char 身上**，不塞进日历设置 —— 塞进日历的话
         日历配一份、聊天配一份，早晚打架（用户的顾虑正是这个）。
         `city` 这个字段本来就有（原本给的 hint 是「用在桌面的双城时间」，
         那个组件早撤了），现在把它扶正成「常驻城市」。 */
      var gPlace = group('常驻地点',
        '他平时待在哪。日历拿它决定用哪国法定节假日、按哪个时区算时间；' +
        '以后要做的语言 / 翻译也从这里推，所以只填这一处。');
      f.city = textField({
        label: '常驻城市',
        hint: '显示用（比如「东京」）。留空就用时区表里的地名',
        value: existing ? (existing.city || '') : '',
        placeholder: '东京'
      });
      gPlace.card.appendChild(f.city.el);

      var regionRow = h('div', 'set-field');
      regionRow.appendChild(h('label', 'set-label', '法定日历'));
      var regionSel = h('select', 'set-select');
      var REGS = (Sleepy.calendarData && Sleepy.calendarData.REGIONS) || [];
      REGS.forEach(function (r) {
        var op = h('option', '', r.label);
        op.value = r.id;
        /* 没有存档 = 跟着默认走（中国大陆），不是「未选择」 */
        if (((existing ? existing.region : '') || 'CN') === r.id) op.selected = true;
        regionSel.appendChild(op);
      });
      regionRow.appendChild(regionSel);
      ui.bindLabel(regionRow, regionSel);
      gPlace.card.appendChild(regionRow);

      var tzRow = h('div', 'set-field');
      tzRow.appendChild(h('label', 'set-label', '常驻时区'));
      var tzSel = h('select', 'set-select');
      var TZS = (Sleepy.calendarData && Sleepy.calendarData.TIMEZONES) || [];
      TZS.forEach(function (tz) {
        var op = h('option', '', tz);
        op.value = tz;
        if (((existing ? existing.timezone : '') || 'Asia/Shanghai') === tz) op.selected = true;
        tzSel.appendChild(op);
      });
      tzRow.appendChild(tzSel);
      ui.bindLabel(tzRow, tzSel);
      gPlace.card.appendChild(tzRow);

      /* 国籍（用户 2026-09-22：「Char 设定说要加国别和时间，没加」）。
         以前只有 city / region / timezone 三件套 —— 它们管**计算**
         （日历用哪国节假日、按哪个时区算现在），但「他是哪国人」这个
         **身份信息**压根没地方写。
         **刻意和那三件分开**：国籍只用于显示 + 文化默认（称呼、口吻），
         **永不参与时间/节假日的推导** —— 所以放这一组最后，hint 里把区别说清。 */
      f.nation = textField({
        label: '国籍',
        hint: '只用于显示 · 日历和时区看上面三项',
        value: existing ? (existing.nationality || '') : '',
        placeholder: '日本 / 中国大陆 / 说不清…'
      });
      gPlace.card.appendChild(f.nation.el);

      /* 换地区就顺手把时区带到那个地区的默认值 ——
         但**只在他没自己挑过时区**时才动，不覆盖手选的。 */
      regionSel.addEventListener('change', function () {
        var meta = null;
        REGS.forEach(function (r) { if (r.id === regionSel.value) meta = r; });
        if (!meta || !meta.timezone) return;
        if (tzSel.__touched !== true) tzSel.value = meta.timezone;
      });
      tzSel.addEventListener('change', function () { tzSel.__touched = true; });
      body.appendChild(gPlace.wrap);

      /* ---- 绑定 User 马甲（1:1 对称）---- */
      var gBind = group('绑定 User 马甲',
        '总纲要求「极致的 1:1 对称」：建 Char 时必须绑定一个 User 马甲。');
      var users = core.userMasks();
      var boundId = existing ? existing.boundUserId : null;

      var uSel = h('select', 'set-input set-select');
      var noneOpt = h('option', '', '（暂不绑定）');
      noneOpt.value = '';
      uSel.appendChild(noneOpt);
      users.forEach(function (u) {
        /* 人设现在是多行的 —— 选项里只取第一行，不然换行会把选择框撑乱 */
        var pLine = u.persona ? String(u.persona).split(/\r?\n/)[0].trim().slice(0, 18) : '';
        var o = h('option', '', core.labelOfUser(u) + (pLine ? ' · ' + pLine : ''));
        o.value = u.id;
        if (u.id === boundId) o.selected = true;
        uSel.appendChild(o);
      });
      var uw = ui.fieldShell('对应的 User 马甲', '切号时，这一对会一起被选中。');
      uw.appendChild(uSel);
      ui.bindLabel(uw, uSel);
      gBind.card.appendChild(uw);

      var maskLink = h('div', 'btn-row');
      maskLink.appendChild(button('管理我的马甲', 'ghost', function () { ctx.open('mask-list'); }));
      gBind.card.appendChild(maskLink);
      body.appendChild(gBind.wrap);

      /* ---- 认知矩阵（只有已建交才显示）---- */
      if (existing && id) {
        var uNow = boundId || (users[0] && users[0].id);
        if (uNow) {
          body.appendChild(cognitionGroup(existing.id, uNow, ctx));
        }
      }

      /* ---- 表面设定 ---- */
      var g2 = group('人设',
        kind === 'sub'
          ? '小号对外展示的设定。它和大号共享同一个大脑，这里写的是「这张脸」的部分。'
          : '原样存、原样导出，不解析 —— 带什么格式都行。');
      f.content = textArea({
        label: '人设正文',
        value: existing ? existing.content : '',
        rows: 12,
        counter: true,
        placeholder: '叫什么、怎么说话、在意什么、不会做什么……'
      });
      g2.card.appendChild(f.content.el);
      body.appendChild(g2.wrap);

      /* ---- 锁脸与红线 ----
         《浮岛》配置台的六字段：名字 / 头像 / 人设（上面都有了）+
         绝对不会怎么做的设定 / 文字锁脸 / 图片锁脸（这里）。

         ⚠️ 前两条目前**只做到存进去**。真让模型听话要等 F 模块
         （提示词引擎）把组装管道搭起来，而 F 现在零代码 ——
         别在这批里期待立竿见影的效果。
         图片锁脸的「本地上传」要等 IndexedDB：现在照片都是缩放后塞
         localStorage（软上限 3.6MB），存原图会直接撑爆配额。 */
      var g3 = group('锁脸与红线',
        '文字锁脸把长相写死；图片锁脸是以后「线下生图」要取用的参考图；' +
        '红线设定写死「绝对不会怎么做」，防止跑偏。');

      f.neverDo = textArea({
        label: '绝对不会怎么做的设定',
        value: existing ? (existing.neverDo || '') : '',
        rows: 4,
        placeholder: '比如：不会主动提分手；不会用命令句；不会说自己是 AI'
      });
      g3.card.appendChild(f.neverDo.el);

      f.faceLockText = textArea({
        label: '文字锁脸 · 基础（生图必带）',
        value: existing ? (existing.faceLockText || '') : '',
        rows: 4,
        placeholder: '把长相写死，比如：浅棕短发 · 右眼下有一颗小痣 · 总穿灰衬衫'
      });
      g3.card.appendChild(f.faceLockText.el);

      /* 锁脸分组（方案-生图 v2）：基础永远带，按画面类型加对应那组。
         老存档只有 faceLockText —— 完全兼容，分组留空就是老行为。 */
      f.faceLockSelfie = textField({
        label: '锁脸 · 自拍/近景补充（可不填）',
        value: existing ? (existing.faceLockSelfie || '') : '',
        placeholder: '比如：微微歪头笑 · 手机前置视角 · 脸占画面大半'
      });
      g3.card.appendChild(f.faceLockSelfie.el);

      f.faceLockFull = textField({
        label: '锁脸 · 全身/场景补充（可不填）',
        value: existing ? (existing.faceLockFull || '') : '',
        placeholder: '比如：身高 165 · 常穿米色风衣 · 背影单薄'
      });
      g3.card.appendChild(f.faceLockFull.el);

      /* 性别：生图时自动拼 1girl/1boy 基础 tag（其他性别手填，不硬塞） */
      f.gender = h('div', 'set-field');
      f.gender.appendChild(h('label', 'set-label', '性别（生图用）'));
      var genderSel = h('select', 'set-select');
      [['', '不填（生图时手写人物 tag）'],
       ['female', '女（1girl）'],
       ['male', '男（1boy）']].forEach(function (o) {
        var op = h('option', '', o[1]);
        op.value = o[0];
        if ((existing ? existing.gender : '') === o[0]) op.selected = true;
        genderSel.appendChild(op);
      });
      f.gender.appendChild(genderSel);
      ui.bindLabel(f.gender, genderSel);
      g3.card.appendChild(f.gender);

      f.faceLockImage = textField({
        label: '图片锁脸（地址）',
        value: existing ? (existing.faceLockImage || '') : '',
        /* 这格目前**没有任何地方读**（生图锁脸用的是 faceLockSelfie/faceLockFull
           文字特征，见 imggen.js faceLockOf）。别接图库 —— 会变成新的「只写不读」。
           等生图支持参考图（img2img）时再接。 */
        hint: '预留 · 生图锁脸目前用下面的文字特征，这格还没接进生图',
        placeholder: 'https://…',
        inputmode: 'url'
      });
      g3.card.appendChild(f.faceLockImage.el);
      body.appendChild(g3.wrap);

      /* ---- 声音（2.15，2026-09-22 接上）----
         角色级的音色 / 频率 / 情绪表达在**单独一页**（page-tts.js 的 char-voice）——
         这一页的字段已经够多了，塞进来会把「锁脸与红线」淹掉。
         只给已经存在的角色入口（新建时还没有 id，设置没地方挂）。 */
      if (existing && Sleepy.tts) {
        var gVoice = group('声音', '让 TA 把回复读出来。音色、频率、情绪表达在单独一页里定。');
        var vCfg = Sleepy.tts.voiceConfigOf(existing.id);
        var vConn = Sleepy.tts.connection(vCfg.connectionId) ||
          Sleepy.tts.connection(Sleepy.tts.settings().defaultConnectionId) ||
          Sleepy.tts.firstConnectionOf(null);
        var vText = !vCfg.enabled ? '没开'
          : (!vCfg.voiceId ? '缺音色 ID'
            : ((Sleepy.tts.hasOwnVoice(existing.id) ? '单独设置' : '跟随默认') +
              ' · ' + Sleepy.tts.connectionSummary(vConn)));
        gVoice.card.appendChild(row({
          label: '角色语音',
          hint: '音色 · 什么时候读 · 允许的情绪与表达',
          badge: vText,
          badgeKind: (vCfg.enabled && vCfg.voiceId) ? 'ok' : 'dim',
          onClick: function () { ctx.open('char-voice', { charId: existing.id }); }
        }));
        body.appendChild(gVoice.wrap);
      }

      /* ---- 记忆（只对大号显示）---- */
      if (existing && kind !== 'npc') {
        body.appendChild(memoryGroup(existing, ctx));
      }

      var btnRow = h('div', 'btn-row');
      var delBtn = button('删除', 'danger');
      if (!existing) delBtn.disabled = true;
      btnRow.appendChild(delBtn);
      btnRow.appendChild(button('导出这个', 'ghost', function () { doExportOne(); }));
      btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
      body.appendChild(btnRow);

      if (existing && kind === 'main') {
        var foot = h('p', 'set-foot',
          '删除大号会把它名下的小号和 NPC 一起删掉。');
        body.appendChild(foot);
      }

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      /* 删除用「再点一次确认」，和「清除全部数据」保持同一套手感 */
      var armed = false;
      var armTimer = null;
      function resetArm() {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        armed = false;
        delBtn.textContent = '删除';
        delBtn.classList.remove('is-armed');
      }
      delBtn.addEventListener('click', function () {
        if (!existing) return;
        if (!armed) {
          armed = true;
          var subs = core.subChars(existing.id).length + core.npcChars(existing.id).length;
          delBtn.textContent = subs
            ? ('再点一次，连同 ' + subs + ' 个下属一起删')
            : '再点一次，确认删除';
          delBtn.classList.add('is-armed');
          armTimer = setTimeout(resetArm, 4000);
          return;
        }
        resetArm();
        /* 项目4：删角色改异步 purgeChar（向量先清拿硬信号才删主表）。
           sandboxId 是角色所属岛（733 行取的 existing.sandboxId 或配置台带入）。
           失败不 toast 成功。 */
        core.purgeChar(existing.id, sandboxId).then(function (r) {
          if (!r || !r.ok) {
            var msg = r && r.message ? r.message : (r && r.why ? r.why : '删除失败');
            ctx.toast(msg, 'err');
            return;
          }
          ctx.toast('已删除', 'ok');
          ctx.back();
        }, function () {
          ctx.toast('删除失败：向量清理异常', 'err');
        });
      });

      function doSave() {
        var name = String(f.name.get() || '').trim() || '未命名角色';
        /* 皮套挂大号；NPC 属于整座岛（parentId = 岛 id），不跟任何人。
           没有房上下文的编辑不动归属字段（老 NPC 保原状，见下面 payload 段）。 */
        var parent = kind === 'main' ? null
          : (kind === 'npc'
            ? (sandboxId || (existing ? existing.parentId : null))
            : (parentSel && parentSel.value ? parentSel.value : parentId));

        if (kind === 'sub' && !parent) {
          ctx.toast('小号得挂在某个大号名下', 'err');
          return;
        }

        var payload = {
          id: existing ? existing.id : core.newId('ch'),
          kind: kind,
          parentId: parent,
          name: name,
          wechatName: String(f.wechatName.get() || '').trim(),
          avatar: String(f.avatar.get() || '').trim(),
          avatarMedia: f.avatar.getMedia(),
          city: String(f.city.get() || '').trim(),
          status: String(f.status.get() || '').trim() || (kind === 'sub' ? '小号' : '在线'),
          /* 常驻地点：日历/时区/以后的语言档都从这三个字段推 */
          region: regionSel.value || 'CN',
          timezone: tzSel.value || 'Asia/Shanghai',
          /* 国籍：**只存不用**（显示 + 文化默认），别拿它去推计算 */
          nationality: String(f.nation.get() || '').trim(),
          boundUserId: uSel.value || null,
          content: f.content.get(),
          neverDo: String(f.neverDo.get() || '').trim(),
          faceLockText: String(f.faceLockText.get() || '').trim(),
          faceLockSelfie: String(f.faceLockSelfie.get() || '').trim(),
          faceLockFull: String(f.faceLockFull.get() || '').trim(),
          gender: genderSel.value || '',
          faceLockImage: String(f.faceLockImage.get() || '').trim()
        };

        /* 全部按房建（2026-09-21 拍板：大号也是每岛一份，没有全局大号）。
           core 的更新分支是按「键在不在」覆盖的，这里只在新键里带 sandboxId。
           parentType：皮套挂 char；NPC 有房上下文就归岛（'sandbox'），
           没有就保原状不动（跟上面 parentId 的口径一致）。 */
        if (kind === 'npc' && sandboxId) {
          payload.parentType = 'sandbox';
        } else if (kind !== 'main') {
          payload.parentType = parentType || 'char';
        }
        if (sandboxId) payload.sandboxId = sandboxId;

        core.upsertChar(payload);

        ctx.toast('已保存', 'ok');
        ctx.back();
      }

      function doExportOne() {
        var one = {
          name: String(f.name.get() || '').trim() || '未命名',
          content: f.content.get()
        };
        if (!String(one.content).trim()) {
          ctx.toast('设定是空的，先写点东西', 'warn');
          return;
        }
        var safe = one.name.replace(/[\\/:*?"<>|]/g, '_');
        var ok = downloadText(safe + '.md', one.content, 'text/markdown');
        if (ok) ctx.toast('已导出「' + one.name + '」', 'ok');
        else ctx.toast('导出失败：浏览器拦下了下载', 'err');
      }
    }
  });

  /* ------------------- 认知矩阵 / 掉马 ------------------- */

  /* 六个状态都收敛成两个布尔维度（cognition × barrier）。
     界面上给的是人话标签 —— 用户不需要知道底下只有两个值。 */
  function cognitionGroup(charId, userId, ctx) {
    var g = group('认知状态（掉马矩阵）',
      '在建立联系的初始由你决定双方的认知状态。这决定模型此刻「知道多少」。');

    var card = g.card;
    var cur = core.cognitionOf(charId, userId);
    var user = core.findUser(userId);

    var box = h('div', 'cog-box');

    function paint() {
      box.innerHTML = '';
      var c = core.cognitionOf(charId, userId);

      /* 两个可点切换的「档位」，比一堆单选更直观 */
      var s1 = h('button', 'cog-opt' + (!c.barrier && c.cognition === 'unaware' ? ' is-on' : ''));
      s1.type = 'button';
      s1.appendChild(h('span', 'cog-opt-title', '不知情 · 拼图局'));
      s1.appendChild(h('span', 'cog-opt-desc',
        '对方不知道这是你的小号。靠全量记忆的碰撞产生既视感和机缘巧合。'));
      s1.addEventListener('click', function () {
        core.setCognition(charId, userId, 'unaware');
        core.setBarrier(charId, userId, false);
        paint();
        ctx.toast('已设为「不知情」', 'ok');
      });
      box.appendChild(s1);

      var s2 = h('button', 'cog-opt' + (!c.barrier && c.cognition === 'aware' ? ' is-on' : ''));
      s2.type = 'button';
      s2.appendChild(h('span', 'cog-opt-title', '已知情 · 调情局'));
      s2.appendChild(h('span', 'cog-opt-desc',
        '对方知道这是你的小号，选择陪着演戏或者故意逗弄。'));
      s2.addEventListener('click', function () {
        core.setCognition(charId, userId, 'aware');
        core.setBarrier(charId, userId, false);
        paint();
        ctx.toast('已设为「已知情」', 'ok');
      });
      box.appendChild(s2);

      var s3 = h('button', 'cog-opt is-danger' + (c.barrier ? ' is-on' : ''));
      s3.type = 'button';
      s3.appendChild(h('span', 'cog-opt-title', '记忆完全隔离 · 平行宇宙'));
      s3.appendChild(h('span', 'cog-opt-desc',
        '检索层直接拦掉非当前马甲组合的记忆。连既视感都没有，纯粹的平行宇宙。'));
      s3.addEventListener('click', function () {
        core.setBarrier(charId, userId, true);
        paint();
        ctx.toast('已开启记忆隔离', 'ok');
      });
      box.appendChild(s3);

      var state = h('p', 'cog-state');
      var name = core.findChar(charId);
      state.textContent = '当前：' +
        (c.barrier ? '平行宇宙（无既视感）'
                   : (c.cognition === 'aware' ? '已知情（明牌）' : '不知情（保护中）')) +
        ' · 面对「' + (user ? user.name : '对方') + '」的这张脸是「' + (name ? name.name : '?') + '」';
      box.appendChild(state);

      card.appendChild(box);

      var acts = h('div', 'btn-row');
      acts.appendChild(button('⚠️ 记忆互通（掉马）', 'danger', function () { doUnmask(); }));
      card.appendChild(acts);

      card.appendChild(h('p', 'set-foot',
        '掉马 = 撤销记忆障壁 + 认知推到「已知情」+ 注入一条系统事件。' +
        '下一轮模型会同时读到两份反差极大的记忆。'));
    }

    async function doUnmask() {
      var yes = await ui.confirm({
        title: '让大小号记忆互通？',
        note: '撤销记忆障壁，双方的身份反差会被直接摊到台面上。这一步之后不好收回。',
        ok: '掉马',
        danger: true
      });
      if (!yes) return;
      var extra = await ui.prompt({
        title: '要额外注入什么事件？',
        note: '留空就用默认的「身份反差暴露」。这条会作为系统事件进上下文。',
        value: '',
        ok: '确认'
      });
      if (extra === null) return;
      var ev = core.unmask(charId, userId, String(extra).trim());
      paint();
      if (ev) ctx.toast('掉马事件已注入', 'ok');
    }

    paint();
    return g.wrap;
  }

  /* ------------------- 记忆（全量 + 四元组） ------------------- */

  function memoryGroup(char, ctx) {
    var rootId = core.rootIdOf(char.id);
    var g = group('记忆库',
      '不管切什么马甲，所有记忆全量存进这个角色的唯一大脑。' +
      '每条都带 [U → C] 四元组标签，保证绝对可溯源 —— 掉马时才对得上号。');

    var box = h('div', 'mem-box');
    var list = core.memoriesOfRoot(rootId).slice().sort(function (a, b) {
      return (b.at || 0) - (a.at || 0);
    });

    if (!list.length) {
      box.appendChild(h('p', 'mem-empty',
        '还没有记忆。聊过天之后，这里会按 [User 马甲 → Char 小号] 归档。'));
    } else {
      list.slice(0, 30).forEach(function (m) {
        var item = h('div', 'mem-item');
        item.appendChild(h('span', 'mem-tag', core.tagOf(m)));
        item.appendChild(h('span', 'mem-text', m.text));
        box.appendChild(item);
      });
      if (list.length > 30) {
        box.appendChild(h('p', 'mem-empty', '…… 共 ' + list.length + ' 条'));
      }

      /* 清空是「再点一次」，跟别处的危险动作保持同一手感 */
      var clr = button('清空这个角色的记忆', 'danger');
      var armed = false;
      var t = null;
      clr.addEventListener('click', function () {
        if (!armed) {
          armed = true;
          clr.textContent = '再点一次，确认清空';
          clr.classList.add('is-armed');
          t = setTimeout(function () {
            armed = false;
            clr.textContent = '清空这个角色的记忆';
            clr.classList.remove('is-armed');
          }, 4000);
          return;
        }
        clearTimeout(t);
        core.dropMemories(function (m) { return m.rootId === rootId; });
        ctx.toast('记忆已清空', 'ok');
        if (ctx.refresh) ctx.refresh();
      });
      box.appendChild(clr);
    }

    g.card.appendChild(box);
    return g.wrap;
  }

  /* ==================== 页面：群聊（跨宇宙投影） ==================== */

  Sleepy.register('contact-group', {
    title: '发起群聊',
    render: function (ctx) {
      var body = ctx.body;
      var picked = {};

      var g = group('勾选要拉进群的大号',
        '群聊会作为「分身」同时投影到各角色的聊天列表里。' +
        '在不同角色的桌面看，视觉氛围完全不同。');

      var mains = core.mainChars();
      if (mains.length < 1) {
        g.card.appendChild(row({ label: '名片夹里还没有大号', plain: true }));
      }

      mains.forEach(function (m) {
        var line = h('button', 'pick-line');
        line.type = 'button';
        line.appendChild(h('span', 'pick-box'));
        line.appendChild(h('span', 'pick-av', core.initialOfUser(m)));
        line.appendChild(h('span', 'pick-name', m.name));
        line.addEventListener('click', function () {
          if (picked[m.id]) delete picked[m.id];
          else picked[m.id] = true;
          line.classList.toggle('is-on', !!picked[m.id]);
        });
        g.card.appendChild(line);
      });

      body.appendChild(g.wrap);

      var btnRow = h('div', 'btn-row');
      btnRow.appendChild(button('建群', 'primary', function () { create(); }));
      body.appendChild(btnRow);

      function create() {
        var ids = Object.keys(picked);
        if (ids.length < 2) {
          ctx.toast('至少勾两个大号才叫群', 'warn');
          return;
        }
        var key = core.groupKeyOf(ids);
        var name = core.makeGroupName(ids);

        /* 群聊对每个成员各有一条对话记录 —— 这就是「分身投影」：
           同一个群，在每个角色的聊天列表里都是独立的一条。
           写入方：拿**全量**（store.get 的原始数组）改完再整表落盘，
           不能拿过滤过的列表，否则别的存档的对话会被冲掉。 */
        var chats = Array.isArray(store.get('chats')) ? store.get('chats') : [];
        var made = 0;
        ids.forEach(function (cid) {
          var exist = false;
          chats.forEach(function (c) {
            if (c.groupKey === key && c.characterId === cid) exist = true;
          });
          if (exist) return;
          var rec = {
            id: core.newId('ct'),
            name: name,
            characterId: cid,
            userId: store.get('activeUserId'),
            groupKey: key,
            groupIds: ids,
            overrides: { temperature: null, maxTokens: null, contextMessages: null, stream: null },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: []
          };
          if (core.tagScope) core.tagScope(rec);   /* 盖上当前房的章 */
          chats.unshift(rec);
          made++;
        });

        store.set('chats', chats);
        if (ctx.toast) ctx.toast(made ? ('已建群，投影到 ' + made + ' 个角色') : '这个群已经在了', made ? 'ok' : 'warn');
        ctx.back();
      }
    }
  });

  /* ==================== 页面：我的马甲 ==================== */

  /* 这张页现在有三个入口，语义各不同但**数据口径唯一**：
     · 浮岛「岛屿总览 → 进入身份」带 sandboxId 进来（看的是**那座岛**）
     · 角色编辑页的「管理我的马甲」不带参数（看**活动岛**）
     · 聊天「我」页的切换账号是另一支（page-switch 的切号器）
     没带 sandboxId 时回落 core.scopeId()，跟以前一致。 */
  Sleepy.register('mask-list', {
    title: '我的马甲',
    render: function (ctx) {
      var body = ctx.body;
      /* 看的是哪座岛：显式给的最优先（总览带进来的），否则活动岛 */
      var sid = ctx.params.sandboxId || (core.scopeId ? core.scopeId() : null);
      var viewing = sid ? core.findSandbox(sid) : null;
      var isActiveIsland = !!sid && store.get('activeSandboxId') === sid;

      var g = group('User 马甲',
        (viewing ? '「' + (viewing.name || '这座岛') + '」里' : '') +
        '的马甲跟岛走：在哪座岛的界面里建就归哪座岛，别岛的不在这里出现。' +
        (isActiveIsland
          ? '点一行 = 在这座岛里切号。'
          : '人不在岛上时点一行 = 把 TA 定成这座岛的进入身份。'));

      var card = g.card;

      function rebuild() {
        card.innerHTML = '';
        /* 只列本岛的马甲（马甲按岛，2026-09-21 拍板）。
           没有活动房时不过滤 —— 那是「还没分房」的状态，全列出来。 */
        var list = core.userMasks().filter(function (u) {
          return u && (!sid || u.sandboxId === sid);
        });
        var activeId = store.get('activeUserId');
        /* 「我的大号」= 本岛那一件 isDefault（老存档没标过就退回名册第一件）。
           落岛时「我」归位到它（core.defaultUserOfSandbox）。 */
        var sbNow = viewing || (core.activeSandbox ? core.activeSandbox() : null);
        var big = sbNow && core.defaultUserOfSandbox ? core.defaultUserOfSandbox(sbNow) : null;
        var bigId = big ? big.id : null;
        /* 指针指向一件**不存在**的马甲时补一次 —— 补的是**本岛的大号**，
           不是 core.activeUser() 的全局兜底（那可能是别座岛的人）。
           人在别座岛时不要动全局指针（见下面点击分支的注释）。 */
        if (isActiveIsland && (!activeId || !core.findUser(activeId))) {
          var fix = big || core.activeUser();
          if (fix) {
            store.set('activeUserId', fix.id);
            activeId = fix.id;
          }
        }

        list.forEach(function (u) {
          var label = core.labelOfUser(u);
          var line = h('button', 'pick-line' + (u.id === activeId ? ' is-on' : ''));
          line.type = 'button';
          var pav = h('span', 'pick-av', core.initialOfUser(u));
          line.appendChild(pav);
          core.setAvatarBg(pav, u);   /* 图库头像（第 14 批的口子），别再只有首字母 */
          var b = h('span', 'pick-name', label);
          if (u.id === activeId && isActiveIsland) b.appendChild(h('span', 'pick-cur', '进行中'));
          line.appendChild(b);

          /* 大号标（用户 2026-09-21）：一座岛里只认一件。
             行本身是 button，HTML 不允许 button 套 button —— 用 span 接点击，
             并 stopPropagation 免得「设为大号」顺带把「我」也切过去。 */
          var isBig = u.id === bigId;
          var chip = h('span', 'pick-big' + (isBig ? ' is-on' : ''),
            isBig ? '大号' : '设为大号');
          chip.title = isBig ? '这座岛里「我」的主账号 —— 降落时直接用它'
            : '把「' + label + '」设成这座岛的大号';
          if (!isBig) {
            chip.addEventListener('click', function (ev) {
              ev.stopPropagation();
              var r = core.setDefaultUser(u.id);
              ctx.toast(r.ok ? ('「' + label + '」是这座岛的大号了') : r.message, r.ok ? 'ok' : 'err');
              if (ctx.rebuild) ctx.rebuild();
            });
          }
          line.appendChild(chip);
          line.addEventListener('click', function () {
            /* 人不在岛上时**不许切号**：切了 activeUserId 会指向别岛的人，
               activeUserOnIsland() 当场返回 null —— 聊天列表整个空掉、
               桌面认不出「我」。这种状态下这一下改成定「进入身份」。 */
            if (!isActiveIsland) {
              var r2 = core.setDefaultUser(u.id);
              ctx.toast(r2.ok
                ? ('进入「' + (viewing && viewing.name ? viewing.name : '这座岛') + '」时用「' + label + '」')
                : r2.message, r2.ok ? 'ok' : 'err');
              if (ctx.rebuild) ctx.rebuild();
              return;
            }
            core.switchTo(undefined, u.id);
            ctx.toast('已切换到「' + label + '」', 'ok');
            if (ctx.rebuild) ctx.rebuild();
          });
          card.appendChild(line);
        });

        var add = h('button', 'pick-line');
        add.type = 'button';
        add.appendChild(h('span', 'pick-box pick-box-plus', '+'));
        add.appendChild(h('span', 'pick-name', '新建一件马甲'));
        /* 带 sandboxId：新建的马甲打**这座岛**的章，不是活动岛的 */
        add.addEventListener('click', function () {
          ctx.open('mask-edit', { id: '', sandboxId: sid || '' });
        });
        card.appendChild(add);
      }

      rebuild();
      /* rebuild 得挂到 ctx 上：①点「设为大号」要原地重画
         ②从 mask-edit 返回时 onShow 要刷新（以前这行一直空转，
         改完大号回到列表看不到变化）。 */
      ctx.rebuild = rebuild;
      body.appendChild(g.wrap);

      body.appendChild(h('p', 'set-foot',
        '马甲决定这座岛里「我是谁」。带「大号」标的那件是主账号，' +
        '降落时「我」就用它。名字可以留空 —— 留空的话对方只知道你的微信名。'));
    },
    /* 岛换了要重画：app.js 的 applyParams 发现 params 变了会整体 re-render，
       所以这里只管「同一座岛回来时刷新」（改了名字/头像/大号）。

       ⚠️ 别在这儿拿 params 去比对岛 —— 那是 render 的活。 */
    onShow: function (ctx) { if (ctx.rebuild) ctx.rebuild(); }
  });

  Sleepy.register('mask-edit', {
    title: '编辑马甲',
    render: function (ctx) {
      var body = ctx.body;
      var id = ctx.params.id || '';
      var existing = id ? core.findUser(id) : null;
      if (id && !existing) { ctx.toast('找不到这件马甲', 'err'); ctx.back(); return; }

      var f = {};
      /* 跟角色编辑页同一套同学录排版（用户：「所有的加人设 char、user、
         npc、大号小号都这样」）—— 左头像框 + 右下划线字段，
         「马甲」那层分组框也就用不上了。 */
      var form = h('div', 'simple-form');
      var top = h('div', 'face-row');
      f.avatar = faceField(existing, {
        empty: '＋',
        /* 名字留空是合法状态 → 首字按「名字 → 微信名」取（core.initialOfUser） */
        initial: existing ? core.initialOfUser(existing) : '',
        toast: function (t, k) { ctx.toast(t, k); }
      });
      top.appendChild(f.avatar.el);
      var cols = h('div', 'face-cols');
      f.name = textField({
        label: '名字',
        /* 用户 2026-09-22：「这个名字下面的注释是小号 A，不对，直接写账号 a 就行，
           名字可以不填，不填的话 char 就只知道微信名（大号小号都是）」。
           → 占位改成中性的一件账号，并且**真的允许留空**（见 doSave）。 */
        value: existing ? existing.name : '',
        placeholder: '账号 a · 可留空'
      });
      if (f.name.input) {
        f.name.input.addEventListener('input', function () {
          f.avatar.setName(f.name.get());
        });
      }
      cols.appendChild(f.name.el);
      f.wechatName = textField({
        label: '微信名',
        value: existing ? (existing.wechatName || '') : '',
        placeholder: '会话列表里显示的名字 · 可留空'
      });
      cols.appendChild(f.wechatName.el);
      top.appendChild(cols);
      form.appendChild(top);

      /* user 的人设（2026-09-22 用户：「群岛和孤岛都没地方写 user 的大号人设，
         只有马甲」）—— 原来这里是**单行**的「一句话人设」，写不下什么。
         改成多行：一句话也行，想写多长写多长（整段会进 [USER_CORE]）。 */
      f.persona = textArea({
        label: '人设',
        value: existing ? (existing.persona || '') : '',
        rows: 6,
        counter: true,
        placeholder: '你在这个身份下是什么样：说话习惯、在意什么、和对方是什么关系……一句话也行，想写长就写长'
      });
      form.appendChild(f.persona.el);

      f.city = textField({
        label: '城市',
        value: existing ? (existing.city || '') : '',
        placeholder: '北京'
      });
      form.appendChild(f.city.el);

      /* 这是我的大号（用户 2026-09-21）：每座岛只认一件，
         降落/换岛时「我」就归位到它 —— 所以得让人能明确指认。
         新建时本岛还没有大号就默认打开。 */
      var sbNow = core.activeSandbox ? core.activeSandbox() : null;
      var bigNow = (sbNow && core.defaultUserOfSandbox) ? core.defaultUserOfSandbox(sbNow) : null;
      f.big = ui.switchField({
        label: '这是我的大号',
        hint: '「我」在这座岛的主账号 · 降落时直接用它（每座岛只认一件）',
        value: existing ? !!existing.isDefault : !bigNow
      });
      form.appendChild(f.big.el);
      body.appendChild(form);

      var btnRow = h('div', 'btn-row');
      var delBtn = button('删除', 'danger');
      if (!existing) delBtn.disabled = true;
      btnRow.appendChild(delBtn);
      btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
      body.appendChild(btnRow);

      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      delBtn.addEventListener('click', async function () {
        if (!existing) return;
        var yes = await ui.confirm({
          title: '删掉「' + existing.name + '」？',
          note: '项目4 起：用它建的对话/关系/朋友圈/线下会话会一并清掉（只清这座岛的）。',
          ok: '删除',
          danger: true
        });
        if (!yes) return;
        var sbId = String(ctx.params.sandboxId || (existing && existing.sandboxId) || '');
        /* 项目4：删马甲改异步 purgeUser（含默认「我」保护 + 跨岛守卫 + 向量门禁）。
           失败不 toast 成功。 */
        core.purgeUser(existing.id, sbId).then(function (r) {
          if (!r || !r.ok) {
            var msg = r && r.message ? r.message : (r && r.why ? r.why : '删除失败');
            ctx.toast(msg, 'err');
            return;
          }
          ctx.toast('已删除', 'ok');
          ctx.back();
        }, function () {
          ctx.toast('删除失败：向量清理异常', 'err');
        });
      });

      function doSave() {
        /* 名字**可以留空**（用户 2026-09-22）：空着的话对外只剩微信名，
           模型也就只知道微信名 —— 所以这里不再兜「未命名马甲」。
           ⚠️ 两件都空也允许（显示侧统一回落「我」，见 core.labelOfUser）。 */
        var name = String(f.name.get() || '').trim();
        /* 这件马甲属于哪座岛：调用方显式给了就以它为准（总览 / 进入身份
           都是带着岛进来的），否则沿用记录上的章，再否则交给 core 盖当前岛章。 */
        var sbId = String(ctx.params.sandboxId || (existing && existing.sandboxId) || '');
        var item = core.upsertUser({
          id: existing ? existing.id : core.newId('um'),
          name: name,
          wechatName: String(f.wechatName.get() || '').trim(),
          persona: String(f.persona.get() || '').trim(),
          city: String(f.city.get() || '').trim(),
          avatar: String(f.avatar.get() || '').trim(),
          avatarMedia: f.avatar.getMedia(),
          isDefault: f.big.get(),
          sandboxId: sbId || undefined
        });
        /* 新建的马甲要**进本岛名册**（sb.maskIds）——
           不然它只是「打了这座岛的章」，masksOfSandbox 看不到它，
           总览的「进入身份」和认知地图里都不会出现（得回配置台勾一次）。
           配置台已经下线（2026-09-22），这里补上这一步。 */
        if (sbId) {
          var sbNow2 = core.findSandbox(sbId);
          if (sbNow2 && !existing) {
            var ids = (sbNow2.maskIds || []).slice();
            if (ids.indexOf(item.id) < 0) {
              ids.push(item.id);
              core.setSandboxMasks(sbId, ids);
            }
          }
        }
        /* 打开开关就互斥地把**同一座岛**其他件降级 —— 每岛只认一件大号，
           别座岛的大号不动（那是别岛的「我」）。 */
        if (f.big.get()) core.setDefaultUser(item.id);
        /* 第一件马甲自动成为当前使用，否则切号器会指向不存在的 id */
        if (!store.get('activeUserId')) core.switchTo(undefined, item.id);
        ctx.toast('已保存', 'ok');
        ctx.back();
      }
    }
  });

  /* 个人资料：**只服务当前账号**。

     用户 2026-09-22：「个人资料就做那种可以在里面直接改当前账号设定和头像
     以及微信名的那种」。跟 mask-edit 的区别：不问 id、不列「这岛有哪几张脸」、
     也不叫「马甲」—— 改的就是此刻戴着的那一张，换个小号进来是它自己的那份。
     排版沿用同学录那一套（左头像框 + 右下划线字段），别处改人设也长这样。 */
  Sleepy.register('me-profile', {
    title: '个人资料',
    render: function (ctx) {
      var u = core.activeUser();
      if (!u) { ctx.toast('还没有账号', 'warn'); ctx.back(); return; }
      var body = ctx.body;
      var f = {};

      var form = h('div', 'simple-form');
      var top = h('div', 'face-row');
      f.avatar = faceField(u, {
        empty: '＋',
        initial: core.initialOfUser(u),
        toast: function (t, k) { ctx.toast(t, k); }
      });
      top.appendChild(f.avatar.el);
      var cols = h('div', 'face-cols');
      f.name = textField({
        label: '名字',
        value: u.name || '',
        placeholder: '我'
      });
      if (f.name.input) {
        f.name.input.addEventListener('input', function () {
          f.avatar.setName(f.name.get());
        });
      }
      cols.appendChild(f.name.el);
      f.wechatName = textField({
        label: '微信名',
        value: u.wechatName || '',
        placeholder: '会话列表里显示的名字 · 可留空'
      });
      cols.appendChild(f.wechatName.el);
      top.appendChild(cols);
      form.appendChild(top);

      f.persona = textArea({
        label: '人设',
        value: u.persona || '',
        rows: 6,
        counter: true,
        placeholder: '我是什么样的人：说话习惯、在意什么、和对方是什么关系……一句话也行，想写长就写长'
      });
      form.appendChild(f.persona.el);

      f.city = textField({
        label: '城市',
        value: u.city || '',
        placeholder: '北京'
      });
      form.appendChild(f.city.el);

      /* 大号开关也在这儿 —— 它同样是「当前账号的设定」，
         而且换了账号之后最容易忘的就是谁是大号。 */
      var sbNow = core.activeSandbox ? core.activeSandbox() : null;
      var bigNow = (sbNow && core.defaultUserOfSandbox) ? core.defaultUserOfSandbox(sbNow) : null;
      f.big = ui.switchField({
        label: '这是我的大号',
        hint: '「我」在这座岛的主账号 · 降落时直接用它（每座岛只认一件）',
        value: !!u.isDefault
      });
      form.appendChild(f.big.el);
      body.appendChild(form);

      var btnRow = h('div', 'btn-row');
      btnRow.appendChild(button('保存', 'primary', function () { doSave(); }));
      body.appendChild(btnRow);
      ctx.setActions([{ label: '保存', kind: 'primary', onClick: function () { doSave(); } }]);

      function doSave() {
        /* 名字可以留空（跟 mask-edit 同一口径）——留空就只剩微信名，
           显示侧统一回落「我」（core.labelOfUser）。 */
        var name = String(f.name.get() || '').trim();
        core.upsertUser({
          id: u.id,
          name: name,
          wechatName: String(f.wechatName.get() || '').trim(),
          persona: String(f.persona.get() || '').trim(),
          city: String(f.city.get() || '').trim(),
          avatar: String(f.avatar.get() || '').trim(),
          avatarMedia: f.avatar.getMedia(),
          isDefault: f.big.get()
        });
        /* 打开开关就互斥地把**同一座岛**其他账号降级 —— 每岛只认一件大号 */
        if (f.big.get()) core.setDefaultUser(u.id);
        ctx.toast('已保存', 'ok');
        ctx.back();
      }
    }
  });

  /* ---------------------------- 对外 ---------------------------- */

  Sleepy.characters = {
    toFileText: toFileText,
    parseFileText: parseFileText,
    importItems: importItems,
    initialOf: core.initialOf,
    summaryOf: core.summaryOf
  };

  /* 头像字段（网址 + 本地图）—— 岛屿配置台的 NPC 编辑页也用它，
     保证「所有角色都有同一个头像入口」（用户 2026-09-21）。 */
  Sleepy.avatarFieldLocal = avatarFieldLocal;
  /* 头像框（点框换图）：编辑页的同学录排版用它，NPC 添加页也走同一个 ——
     头像入口全站只有一个形状 */
  Sleepy.faceField = faceField;

  /* 角色文件的导入导出出口。名片夹下线之后，这两个动作的入口在
     **岛屿配置台**（「往这间房加人」），所以由它来调。
     parseFileText / importItems 也给冒烟当纯函数断言用。 */
  Sleepy.charIO = {
    importInto: importInto,
    exportAll: exportAll,
    parseFileText: parseFileText,
    importItems: importItems
  };

})(window);
