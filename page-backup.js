/* ============================================================
   page-backup.js — 数据与备份
   依赖：store.js、ui.js、app.js（必须在它们之后加载）
   覆盖 ROADMAP：2.5 导出/导入 · 2.6 体积 + 清理 · 2.7 清除数据
   页面：settings-backup（从 设置 → 数据与备份 进入）

   为什么是 .json 而不是 ZIP：
     压缩得引第三方库，和「零依赖 + 全原创」两条原则都冲突。
     v1 先用 .json 全量存档，结构就是 store.exportUserData() 那个。
     （用户备份只装**正式存档**；迁移备份 / 迁移事务状态 / 索引回滚进度
       这些过程数据不进备份，见 store.isProcessKey 的注释。）
     以后真要有压缩需求，优先等原生 CompressionStream 铺开，
     而不是往工程里塞一个别人的库。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var store = Sleepy.store;
  var ui = Sleepy.ui;

  var h = ui.h;
  var group = ui.group;
  var row = ui.row;
  var setRowValue = ui.setRowValue;
  var button = ui.button;
  var fmtBytes = ui.fmtBytes;
  var downloadText = ui.downloadText;

  var FILE_PREFIX = 'sleepy';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function stamp() {
    var d = new Date();
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
           '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /* 下载逻辑已经提到 ui.downloadText（导出人设预设也要用），这里不再自留一份 */

  /* ==================== 清空 / 导入的真实流程（2026-09-23 项目 1 · 复核修订版） ====================

     为什么把这两段从 render 闭包里抽出来：按钮回调困在闭包里外部调不到，
     行为只能靠「看代码」验证。抽成具名函数 + Sleepy.backupApp 导出之后，
     冒烟走的是**和按钮同一个函数**，而不是复制一份逻辑来测。

     三条硬规矩（用户 2026-09-23 拍板 + 复核修订）：
       ① 不许假成功：清空要各项**都成功**才提示完成；导入要向量库真的清干净了才往下写；
          任一步失败就报错，**不刷新页面**。
       ② **回滚要说真话**（复核修订）：导入失败时不是只恢复 localStorage ——
          旧向量块（含原文）+ 索引进度（游标 / 退避 / 世代号）**一起**恢复，
          恢复完还要**验证**；验证不过就**保留快照**并明说「恢复未完成」。
          只恢复 localStorage 却写「完整回滚」，是把「向量库为空」这种不一致状态藏起来。
       ③ 快照的寿命有讲究（复核修订）：
            导入成功   → 删快照
            回滚成功   → 删快照
            回滚失败   → **保留快照**（下次进来还能接着处理）
          「无论如何都删」是错的 —— 那会把最后一份能回去的数据也扔掉。
  ================================================================================ */

  /* 恢复区：**刻意不用 store 的 sleepy.v1. 前缀**。
     store.clearAll() 只删 sleepy.v1.*，exportAll() 也只扫 sleepy.v1.* ——
     所以恢复区既能躲过「清空」，也不会被当成用户数据导出到备份文件里。
     （用户口径：importRollback 不能放在 importAll/clearAll 会覆盖或清掉的同一命名空间。）

     结构：
       {
         v: 1, at: <时间戳>,
         local: <store.exportInternalSnapshot() 的结果>, // 本地存档（**含**过程数据）
         index: { cursors: {}, fails: {}, epoch: n }, // 索引进度（memoryVec.indexState）
         vecBlocks: <快照库里的块数>,                  // 验证用；块本体在 IDB 快照库
         status: 'pending' | 'restore-failed'
       }
     块本体不进这里：它们可能几十 MB，localStorage 装不下 —— 走独立 IDB 库 sleepy-vec-snap
     （见 memory-vec.js 的 snapBlocks / snapRestore / snapDrop）。 */
  var RB_PREFIX = 'sleepy.rb.';
  var RB_KEY = RB_PREFIX + 'pending';

  function rawLS() { return global.localStorage; }

  /* 每一步都带 key（用户口径：清空结果要按 localStorage / media / vector /
     migrationArtifacts / restoreArtifacts / memoryCache 分别报告） */
  function step(key, name, ok, detail) {
    return { key: key, name: name, ok: !!ok, detail: detail || '' };
  }

  function reportOf(steps) {
    return steps.map(function (s) {
      return s.name + '：' + (s.ok ? (s.detail || '已清') : ('失败 —— ' + (s.detail || '未知原因')));
    }).join('；');
  }

  /* steps → 用户要的结果对象（同名 key 覆盖，任一失败则整体 ok=false） */
  function resultOf(steps) {
    var out = { ok: true };
    steps.forEach(function (s) {
      if (s.key) out[s.key] = { ok: s.ok, detail: s.detail };
      if (!s.ok) out.ok = false;
    });
    return out;
  }

  function saveRestore(meta) {
    try { rawLS().setItem(RB_KEY, JSON.stringify(meta)); return true; }
    catch (e) { return false; }
  }
  function takeRestore() {
    try {
      var raw = rawLS().getItem(RB_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function dropRestore() {
    try { rawLS().removeItem(RB_KEY); } catch (e) { /* 删不掉也不该拦住流程 */ }
  }

  /* 把恢复区里的存档写回 store。先 clearAll 再逐键写，
     保证「写回」是覆盖式、且内存缓存与磁盘一致（clearAll 会清缓存）。
     失败时**抛错**（不是返回 false）：调用方要能一眼区分「恢复了」和「恢复没成功」，
     因为后者必须保留快照、报「恢复未完成」。 */
  function restoreStore(meta) {
    var data = meta && meta.local && meta.local.data;
    if (!data) throw new Error('快照里没有可恢复的存档');
    store.clearAll();
    var ls = rawLS();
    var ns = store.NS || 'sleepy.v1.';
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      ls.setItem(ns + keys[i], JSON.stringify(data[keys[i]]));
    }
    return keys.length;
  }

  /* 回滚失败时**保留**快照，只把状态和原因写进去 ——
     它是用户现在唯一能回去的地方，不能因为「这次没成功」就删掉。 */
  function keepRestore(meta, why, r) {
    var m = meta || takeRestore() || {};
    m.v = m.v || 1;
    m.status = 'restore-failed';
    m.failedAt = Date.now();
    m.failReason = (why || '') + ' / ' + ((r && r.detail) || '未知原因');
    saveRestore(m);
    return m;
  }

  /* 回滚成功之后才丢快照（本地 + 向量快照库一起丢） */
  function dropSnapAll() {
    var mv = Sleepy.memoryVec;
    dropRestore();
    if (mv && typeof mv.snapDrop === 'function') return mv.snapDrop();
    return Promise.resolve(true);
  }

  function vecWhyText(r) {
    if (!r) return '清理失败';
    if (r.why === 'blocked') return '另一个标签页占着向量库，先关掉它再清';
    if (r.why === 'residual') return '清完还剩 ' + r.total + ' 块（没清干净）';
    if (r.why === 'count') return '快照块数对不上（快照 ' + r.want + ' / 实际 ' + r.got + '）';
    if (r.why === 'noidb') return '本机没有 IndexedDB';
    return r.message || '清理失败';
  }

  function errText(e) { return (e && e.message) || String(e || '未知原因'); }

  function mediaClearStep() {
    var m = Sleepy.media;
    if (!m || typeof m.clear !== 'function') return Promise.resolve(step('media', '图库', true, '这一版没有图库'));
    /* 先探活再清：这台设备压根没有 IDB（无痕模式等）时**没有对象可清**，
       不该算「清理失败」—— 和 wipeAll 的三态是同一个口径。 */
    return m.available().then(function (yes) {
      if (!yes) return step('media', '图库', true, '本机没有图库，无需清理');
      return m.clear().then(
        function () { return step('media', '图库', true); },
        function (e) { return step('media', '图库', false, errText(e)); });
    }, function () { return step('media', '图库', true, '本机没有图库，无需清理'); });
  }

  /* 向量库清理 → 一个步骤结果。三态到步骤的映射是关键：
     cleared / not-applicable 都算「这一步过了」（后者是「没有对象可清」），
     只有 failed 才算失败。 */
  function vectorWipeStep() {
    var mv = Sleepy.memoryVec;
    if (!mv || typeof mv.wipeAll !== 'function') {
      return Promise.resolve(step('vector', '向量库', true, '这一版没有向量库'));
    }
    return mv.wipeAll().then(function (r) {
      if (r.status === 'cleared') return step('vector', '向量库', true, '已清空');
      if (r.status === 'not-applicable') return step('vector', '向量库', true, '本机没有向量库，无需清理');
      return step('vector', '向量库', false, vecWhyText(r));
    }, function (e) {
      return step('vector', '向量库', false, errText(e));
    });
  }

  /* ---- 迁移过程数据（项目 5 会产生的敏感中间物）----
     迁移备份（charMemBackup:*，里面是分叉前的记忆原文）与迁移事务状态
     （charMemMigrationState）都属于「设备上的旧记忆」—— 清空必须能清掉它们，
     不能等项目 5 做完再回来补这个入口。现在多半还不存在：不存在也算成功。 */
  var MIGRATION_KEYS = ['charMemMigrationState'];
  var MIGRATION_PREFIXES = ['charMemBackup:'];

  function clearMigrationArtifacts() {
    var n = 0;
    try {
      var ls = rawLS();
      var ns = store.NS || 'sleepy.v1.';
      var doomed = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(ns) !== 0) continue;
        var top = k.slice(ns.length);
        var hit = MIGRATION_KEYS.indexOf(top) >= 0;
        for (var j = 0; !hit && j < MIGRATION_PREFIXES.length; j++) {
          if (top.indexOf(MIGRATION_PREFIXES[j]) === 0) hit = true;
        }
        if (hit) doomed.push(top);
      }
      doomed.forEach(function (t) { store.remove(t); n++; });
    } catch (e) {
      return { ok: false, detail: '读不到本地存储：' + errText(e) };
    }
    var mv = Sleepy.memoryVec;
    var cursors = 0, fails = 0;
    if (mv) {
      /* 进度的残留同样属于「过程数据」：退避记录不清，接口好了也还要等；
         游标不清，下一轮会以为已经索引过（而块已经没了）。前缀按 vecCursor 匹配、
         不绑版本号（项目 5 会把前缀从 3 换到 4）。 */
      if (typeof mv.clearFailures === 'function') fails = mv.clearFailures();
      if (typeof mv.clearCursors === 'function') cursors = mv.clearCursors();
    }
    return {
      ok: true,
      detail: (n ? '迁移备份 ' + n + ' 项' : '没有迁移备份') +
        '、游标 ' + cursors + ' 项、退避 ' + fails + ' 项'
    };
  }

  /* 恢复区（sleepy.rb.*）+ 向量快照库 —— 这两样都含旧数据的原文，必须一起清 */
  function clearRestoreArtifacts() {
    var n = 0;
    try {
      var ls = rawLS();
      var doomed = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (k && k.indexOf(RB_PREFIX) === 0) doomed.push(k);
      }
      doomed.forEach(function (k) { ls.removeItem(k); n++; });
    } catch (e) {
      return Promise.resolve({ ok: false, detail: '清不掉恢复区：' + errText(e) });
    }
    var mv = Sleepy.memoryVec;
    if (!mv || typeof mv.snapDrop !== 'function') {
      return Promise.resolve({ ok: true, detail: '恢复区 ' + n + ' 项' });
    }
    return mv.snapDrop().then(function (ok) {
      return {
        ok: ok,
        detail: '恢复区 ' + n + ' 项' + (ok ? '、向量快照库已清' : '；向量快照库没清干净')
      };
    }, function (e) {
      return { ok: false, detail: '清向量快照库失败：' + errText(e) };
    });
  }

  /* 清空全部数据：**非原子**，按用户指定的六项分别报告。
     原来那版不管图库清没清干净都 toast「已清除」并刷新 —— 用户看不到残留，
     而残留的正是含原文的向量块与快照（最该清掉的东西）。 */
  function clearEverything() {
    var steps = [];
    var mv = Sleepy.memoryVec;

    /* ① 本地数据 */
    var localOk = true, localDetail = '';
    try { store.clearAll(); }
    catch (e) { localOk = false; localDetail = errText(e); }
    steps.push(step('localStorage', '本地数据', localOk, localDetail));

    return mediaClearStep().then(function (s) {          /* ② 图库 */
      steps.push(s);
      return vectorWipeStep();                           /* ③ 向量库（块） */
    }).then(function (s) {
      steps.push(s);
      var mig = clearMigrationArtifacts();               /* ④ 迁移过程数据 + 索引进度 */
      steps.push(step('migrationArtifacts', '迁移过程数据', mig.ok, mig.detail));
      return clearRestoreArtifacts();                    /* ⑤ 恢复区 + 向量快照库 */
    }).then(function (s) {
      steps.push(step('restoreArtifacts', '恢复快照', s.ok, s.detail));

      /* ⑥ 召回内存缓存（不清的话，清空之后这一会话还能从缓存里注入旧内容） */
      var cacheOk = true, cacheDetail = '召回缓存已清';
      try {
        if (mv && typeof mv.clearCache === 'function') mv.clearCache();
        else cacheDetail = '这一版没有向量库';
      } catch (e) { cacheOk = false; cacheDetail = errText(e); }
      steps.push(step('memoryCache', '内存缓存', cacheOk, cacheDetail));

      return {
        ok: !steps.filter(function (x) { return !x.ok; }).length,
        steps: steps,
        message: reportOf(steps),
        result: resultOf(steps)
      };
    });
  }

  /* ---- 回滚：本地存档 + 旧向量块 + 索引进度，一起恢复并验证 ----
     返回 { ok, step, detail }。**不在这里删快照** —— 由调用方按结果决定去留。 */
  function doRestore(meta) {
    var mv = Sleepy.memoryVec;

    /* 1) 本地存档 */
    try { restoreStore(meta); }
    catch (e) { return Promise.resolve({ ok: false, step: '本地数据', detail: '恢复本地数据失败：' + errText(e) }); }

    if (!mv || typeof mv.snapRestore !== 'function') {
      return Promise.resolve({
        ok: false, step: '向量块',
        detail: '这一版没有向量库，无法恢复向量块（快照记了 ' + ((meta && meta.vecBlocks) || 0) + ' 块）'
      });
    }

    /* 2) 旧向量块 */
    return mv.snapRestore().then(function (r) {
      if (!r || !r.ok) {
        return { ok: false, step: '向量块', detail: '恢复向量块失败：' + vecWhyText(r) };
      }
      /* 3) 索引进度（游标 / 退避 / 世代号）—— 不恢复它，块回来了也会错位 */
      var idx = (typeof mv.restoreIndexState === 'function')
        ? mv.restoreIndexState(meta && meta.index) : { ok: true };
      if (!idx || !idx.ok) {
        return { ok: false, step: '索引状态', detail: '恢复索引状态失败：' + errText(idx && idx.message) };
      }
      /* 4) 验证：恢复后的块数必须等于快照里记的数 */
      return verifyRestore(meta).then(function (v) {
        if (!v.ok) return { ok: false, step: '验证', detail: '恢复校验不通过：' + v.detail };
        return { ok: true, detail: '已按快照恢复（本地存档 + ' + ((r.count) || 0) + ' 块向量 + 索引进度）' };
      });
    }, function (e) {
      return { ok: false, step: '向量块', detail: '恢复向量块抛错：' + errText(e) };
    });
  }

  /* 恢复验证：读回来的块数 == 快照里记的块数。
     （无 IDB 时两边都是 0，天然通过；真机上这条就是「块真回来了没」的判据。） */
  function verifyRestore(meta) {
    var want = (meta && typeof meta.vecBlocks === 'number') ? meta.vecBlocks : 0;
    var mv = Sleepy.memoryVec;
    if (!mv || typeof mv.total !== 'function') {
      return Promise.resolve({ ok: want === 0, detail: '没有向量库，快照记了 ' + want + ' 块' });
    }
    return mv.total().then(function (got) {
      if (got !== want) return { ok: false, detail: '快照 ' + want + ' 块、恢复后 ' + got + ' 块' };
      return { ok: true, detail: want + ' 块' };
    }, function (e) { return { ok: false, detail: '取块数失败：' + errText(e) }; });
  }

  /* ---- 建快照：本地存档 + 旧向量块 + 索引进度。三步都成了才算有快照 ----
     本地那份用 **exportInternalSnapshot**（不是用户导出的那份）：
     回滚的目的是「回到那一刻」，所以迁移备份 / 迁移事务状态 / 索引回滚进度
     这些**过程数据也必须一起还原** —— 只还原正式数据会让进度的账对不上
     （用户口径 2026-09-23：用户导出排除过程数据，内部快照必须含）。 */
  function snapshotAll() {
    var mv = Sleepy.memoryVec;
    var meta = {
      v: 1, at: Date.now(), status: 'pending',
      local: store.exportInternalSnapshot(),
      index: (mv && typeof mv.indexState === 'function') ? mv.indexState() : { cursors: {}, fails: {}, epoch: 0 },
      vecBlocks: 0
    };
    if (!mv || typeof mv.snapBlocks !== 'function') {
      if (!saveRestore(meta)) return Promise.resolve({ ok: false, message: '存不下恢复快照（本地存储是不是满了？）' });
      return Promise.resolve({ ok: true, meta: meta, detail: '本地存档（这一版没有向量库）' });
    }
    return mv.snapBlocks().then(function (r) {
      if (!r || !r.ok) return { ok: false, message: '旧向量块没能存进快照：' + vecWhyText(r) };
      meta.vecBlocks = r.count || 0;
      if (!saveRestore(meta)) return { ok: false, message: '存不下恢复快照（本地存储是不是满了？）' };
      return { ok: true, meta: meta, detail: '本地存档 + ' + meta.vecBlocks + ' 块向量 + 索引进度' };
    }, function (e) {
      return { ok: false, message: '建快照抛错：' + errText(e) };
    });
  }

  /* ---- 上一次导入没回滚成功：进来接着处理（用户口径：下次启动时要能发现并继续）---- */
  function resumeRestore() {
    var meta = takeRestore();
    if (!meta || !meta.local) return Promise.resolve({ ok: false, message: '没有可处理的恢复快照' });
    var mv = Sleepy.memoryVec;
    if (mv && mv.pauseRecall) mv.pauseRecall();
    return doRestore(meta).then(function (r) {
      if (mv && mv.resumeRecall) mv.resumeRecall();
      if (r.ok) { dropSnapAll(); return { ok: true, message: '恢复完成：' + r.detail }; }
      keepRestore(meta, '继续处理仍然失败', r);
      return { ok: false, message: '恢复仍未完成：' + r.detail + '（快照继续保留）' };
    });
  }

  /* 导入备份。顺序（用户 2026-09-23 拍板 + 复核修订）：
     ① 完整校验，一个字都不写 —— 校验不过：不清空、不写、**不建快照**
     ② 关召回门
     ③ 建快照：本地存档 + 旧向量块 + 索引进度
     ④ 清向量库（清不干净就中止并回滚）
     ⑤ 覆盖写入
     ⑥ 任一步失败 → 回滚（本地 + 块 + 索引状态）→ **验证** → 按结果决定快照去留
     ⑦ 成功 → 删快照 → 开门 → 由调用方 reload */
  function importEverything(payload) {
    /* ① 只校验，不写入 */
    var v = store.canImport ? store.canImport(payload) : { ok: true };
    if (!v.ok) {
      return Promise.resolve({
        ok: false,
        steps: [step('', '校验备份', false, v.message)],
        message: v.message,
        restored: 'none'
      });
    }

    var mv = Sleepy.memoryVec;
    var steps = [step('', '校验备份', true)];
    var meta = null;

    /* ② 关召回门：从「建快照」到「写盘 / 回滚结束」都不许召回 */
    if (mv && typeof mv.pauseRecall === 'function') mv.pauseRecall();
    function releaseRecall() {
      if (mv && typeof mv.resumeRecall === 'function') mv.resumeRecall();
    }

    function done(ok, why, restored) {
      var out = {
        ok: ok,
        steps: steps,
        message: ok ? reportOf(steps) : (why + '（' + reportOf(steps) + '）'),
        restored: restored
      };
      if (ok) out.reload = true;      /* 只有成功才让调用方刷新 */
      return out;
    }

    /* 失败统一出口：回滚 → 按回滚结果决定快照去留 → 开门 → 返回（**不 reload**） */
    function rollback(why) {
      return doRestore(meta).then(function (r) {
        if (r.ok) {
          steps.push(step('', '回滚', true, r.detail));
          dropSnapAll();                       /* 回滚成功 → 快照使命完成 */
          releaseRecall();
          return done(false, why, 'ok');
        }
        /* 回滚失败 / 验证不通过 → **保留快照**，明说「恢复未完成」 */
        steps.push(step('', '回滚', false,
          r.detail + '（快照已保留，下次进「数据与备份」可继续处理）'));
        keepRestore(meta, why, r);
        releaseRecall();
        return done(false, why + '；恢复未完成，恢复快照仍保留', 'failed');
      });
    }

    return snapshotAll().then(function (snap) {
      if (!snap.ok) {
        /* 还没动任何数据 → 直接开门收工（半份快照也不留） */
        steps.push(step('', '保存恢复快照', false, snap.message));
        releaseRecall();
        return done(false, '建快照失败，已中止（你的数据一个字都没动）', 'none');
      }
      meta = snap.meta;
      steps.push(step('', '保存恢复快照', true, snap.detail));

      /* ④ 清向量库 */
      return vectorWipeStep().then(function (s) {
        steps.push(s);
        if (!s.ok) return rollback('向量库没能清干净，已中止导入');

        /* ⑤ 覆盖写入：先清**正式数据**（旧存档里没有的键不能留成幽灵数据）再写。
           这里是 clearUserData 而不是 clearAll —— 用户备份导入不该把本机
           正在跑的迁移 / 恢复事务状态也一起抹掉（用户口径 2026-09-23）。 */
        try { store.clearUserData(); } catch (e) { /* 下面 importAll 会重写 */ }
        var res = store.importAll(payload);
        var skippedCount = ((res && res.skipped) || []).length;
        var wanted = Object.keys(payload.data).length - skippedCount;
        if (!res.ok) return rollback(res.message || '写入失败');
        if (!res.keys || res.keys.length < wanted) {
          return rollback('有 ' + (wanted - ((res.keys && res.keys.length) || 0)) + ' 项没能写进去');
        }
        steps.push(step('', '写入备份', true,
          res.keys.length + ' 项' + (skippedCount ? ('（按口径忽略 ' + skippedCount + ' 项过程数据）') : '')));

        /* ⑦ 成功：快照删掉（不留长期残留）；门在这里就开 ——
           数据已覆盖写完、旧块也清了，留着关反而会变成「导入过之后就再也不召回」。 */
        dropSnapAll();
        releaseRecall();
        return done(true, null, 'none');
      });
    });
  }

  Sleepy.register('settings-backup', {
    title: '数据与备份',
    render: function (ctx) {
      var body = ctx.body;

      /* ---------------- 导入用的隐藏 file input ---------------- */

      var fileInput = h('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', onPick);
      body.appendChild(fileInput);

      function onPick() {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        var reader = new global.FileReader();
        reader.onload = function () {
          var data = null;
          try { data = JSON.parse(String(reader.result)); } catch (e) { data = null; }
          if (!data) {
            ctx.toast('这个文件读不出内容，确认选的是 Sleepy 的备份 json', 'err');
            return;
          }
          /* 走 importEverything：校验 → 快照（本地 + 旧向量块 + 索引进度）→ 清向量库
             → 覆盖写 → 失败回滚。成功才刷新；失败**留在本页**并把逐项结果说清楚
             （刷新会掩盖残留）。回滚也失败时快照会被保留，页面顶部会出现「继续恢复」。 */
          importEverything(data).then(function (r) {
            if (r.ok) {
              ctx.toast('导入成功，正在刷新…', 'ok');
              setTimeout(function () { global.location.reload(); }, 700);
            } else if (r.restored === 'failed') {
              ctx.toast('导入失败，自动回滚也没完成：' + r.message, 'err');
              refresh();
            } else {
              ctx.toast('导入没完成：' + r.message, 'err');
            }
          });
        };
        reader.onerror = function () { ctx.toast('读取文件失败', 'err'); };
        reader.readAsText(f);
        fileInput.value = '';
      }

      /* ------------------- 上次导入未完成（异常状态，**必须置顶**） -------------------
         导入失败且自动回滚也失败时，这里躺着一份「导入前」的快照。
         它放在**页面最上面**是刻意的：这是唯一能回去的地方，
         而且用户不会主动往下滚着找它（2026-09-23 真机验收就是没找到 ——
         当时它排在「图库」之后，用户在页面中部就以为没有）。
         它不会被「清空」以外的东西自动删掉，也不会进导出文件。 */
      var pending = takeRestore();
      if (pending && pending.local) {
        var gR = group('上次导入未完成',
          '导入失败后自动回滚也失败了，所以这里保留着**导入前的那份快照** —— ' +
          '它是现在唯一能回去的地方，恢复成功之前不会删。');
        gR.card.appendChild(row({
          label: '继续恢复',
          hint: pending.failReason ? ('上次的原因：' + pending.failReason).slice(0, 60) : '按快照恢复',
          onClick: function () {
            resumeRestore().then(function (r) {
              if (r.ok) {
                ctx.toast(r.message + '，正在刷新…', 'ok');
                setTimeout(function () { global.location.reload(); }, 700);
              } else {
                ctx.toast(r.message, 'err');
              }
            });
          }
        }));
        body.appendChild(gR.wrap);
      }

      /* ---------------------------- 备份 ---------------------------- */

      var g1 = group('备份',
        '导出的是 Sleepy 自己的存档格式（.json），换设备时用它搬家。' +
        '**图片不在里面** —— 那些存在图库里（IndexedDB），换设备要重新传一次。');
      g1.card.appendChild(row({
        label: '导出备份',
        hint: '含设置、Key 和以后的所有聊天记录',
        value: fmtBytes(store.usage().bytes),
        onClick: function () { doExport(); }
      }));
      g1.card.appendChild(row({
        label: '导入备份',
        hint: '会覆盖当前数据，导之前先导出一次',
        onClick: function () { fileInput.click(); }
      }));
      body.appendChild(g1.wrap);

      /* -------------------------- 存储空间 -------------------------- */

      var g2 = group('存储空间', '只统计 Sleepy 自己的键，不碰同域下别的数据。');
      var rowSize = row({ label: '已用空间', plain: true });
      var rowCount = row({ label: '存储项', plain: true });
      var rowState = row({ label: '写入状态', plain: true });
      g2.card.appendChild(rowSize);
      g2.card.appendChild(rowCount);
      g2.card.appendChild(rowState);
      body.appendChild(g2.wrap);

      /* -------------------------- 图库（IndexedDB） --------------------------

         图片本体**不在**上面那三个数里：它们在 IndexedDB，配额是磁盘级的
         （几百 MB 起），所以这里单独一组。用户要的「方便之后存图」就是这一层。 */
      var gLib = group('图库',
        '照片、聊天里发的图存在这里（IndexedDB）。它不占 localStorage 那 5MB，' +
        '所以上面那几个数字看不见它们。');

      var rowLibSize = row({ label: '图库占用', plain: true });
      var rowLibCount = row({ label: '图片张数', plain: true });
      var rowLibState = row({ label: '存放位置', plain: true });
      gLib.card.appendChild(rowLibSize);
      gLib.card.appendChild(rowLibCount);
      gLib.card.appendChild(rowLibState);
      body.appendChild(gLib.wrap);

      /* 清图库：同样是破坏性操作，走两次点击确认（跟「清除全部数据」一个规矩）。
         **只清图片本体**，聊天记录 / 相册列表不动 —— 那些记录会显示成
         「这张图找不到了」，用户至少知道自己删过什么。 */
      var libArmed = false;
      var libTimer = null;
      var libBtn = button('清空图库（只删图片本身）', 'ghost', function () {
        if (!libArmed) {
          libArmed = true;
          libBtn.textContent = '再点一次，确认清空';
          libBtn.classList.add('is-armed');
          libTimer = setTimeout(resetLibArm, 4000);
          return;
        }
        resetLibArm();
        if (!Sleepy.media) return;
        Sleepy.media.clear().then(function () {
          ctx.toast('图库已清空', 'ok');
          refresh();
        }, function (e) {
          ctx.toast((e && e.message) || '清不掉', 'err');
        });
      });

      function resetLibArm() {
        if (libTimer) { clearTimeout(libTimer); libTimer = null; }
        libArmed = false;
        libBtn.textContent = '清空图库（只删图片本身）';
        libBtn.classList.remove('is-armed');
      }

      var libRow = h('div', 'btn-row');
      libRow.appendChild(libBtn);
      gLib.card.appendChild(libRow);

      /* -------------------------- 危险操作 -------------------------- */

      var g3 = group('危险操作', '清除后聊天记录和 API 配置会一起消失，无法恢复。清除前先导出备份。');

      var armed = false;
      var armTimer = null;

      var delBtn = button('清除全部数据', 'danger', function () {
        if (!armed) {
          armed = true;
          delBtn.textContent = '再点一次，确认清除';
          delBtn.classList.add('is-armed');
          armTimer = setTimeout(resetArm, 4000);
          return;
        }
        resetArm();
        /* 六项各自的结果都要看（本地数据 / 图库 / 向量库 / 迁移过程数据 /
           恢复快照 / 内存缓存）。任一项失败就报错、**不刷新** ——
           刷新会让人以为清完了，而残留的恰恰是含原文的向量块与快照。 */
        clearEverything().then(function (r) {
          if (r.ok) {
            ctx.toast('已清除，正在刷新…', 'ok');
            setTimeout(function () { global.location.reload(); }, 700);
          } else {
            ctx.toast('没清干净：' + r.message, 'err');
          }
        });
      });

      function resetArm() {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        armed = false;
        delBtn.textContent = '清除全部数据';
        delBtn.classList.remove('is-armed');
      }

      var btnRow = h('div', 'btn-row');
      btnRow.appendChild(delBtn);
      g3.card.appendChild(btnRow);
      body.appendChild(g3.wrap);

      body.appendChild(h('p', 'set-foot',
        '所有数据只存在这台设备上，不会上传到任何服务器。'));

      function refresh() {
        var u = store.usage();
        setRowValue(rowSize, fmtBytes(u.bytes));
        setRowValue(rowCount, u.keys + ' 项');

        var err = store.lastError();
        if (err && err.type === 'write') {
          setRowValue(rowState, '上次写入失败');
          if (err.message) rowState.title = err.message;
        } else {
          setRowValue(rowState, '正常');
        }

        /* 图库那三个数是异步查的（要开一次 IndexedDB），先占个位 */
        var m = Sleepy.media;
        if (!m) { libUnavailable('这台设备没有 IndexedDB'); return; }
        setRowValue(rowLibSize, '…');
        setRowValue(rowLibState, '…');
        setRowValue(rowLibCount, '…');
        m.available().then(function (yes) {
          if (!yes) { libUnavailable('用不了（无痕模式，或浏览器禁了）'); return; }
          setRowValue(rowLibState, 'IndexedDB（只在本机）');
          return m.usage().then(function (r) {
            setRowValue(rowLibSize, fmtBytes(r.bytes));
            setRowValue(rowLibCount, r.count + ' 张');
          });
        });
      }

      function libUnavailable(why) {
        setRowValue(rowLibState, why);
        setRowValue(rowLibSize, '—');
        setRowValue(rowLibCount, '—');
      }

      function doExport() {
        /* 用户导出走 **exportUserData**：单独排除迁移备份 / 迁移事务状态 /
           索引回滚进度这些**过程数据** —— 备份只装正式存档，换设备导入时
           也不该把旧的迁移过程带回新设备（用户口径 2026-09-23）。 */
        var payload = store.exportUserData();
        var text = JSON.stringify(payload, null, 2);
        var ok = downloadText(FILE_PREFIX + '-' + stamp() + '.json', text, 'application/json');
        if (ok) ctx.toast('已导出 · ' + fmtBytes(store.usage().bytes), 'ok');
        else ctx.toast('导出失败：浏览器拦下了下载', 'err');
        refresh();
      }

      refresh();

      ctx.setActions([{
        label: '导出',
        kind: 'primary',
        onClick: function () { doExport(); }
      }]);
    },
    onShow: function (ctx) { /* 体积在 render 里算过一次，返回时无需重算 */ }
  });

  /* 清空 / 导入的真实流程——给按钮用，也给冒烟走**同一条路**（见上面的注释）。
     RB_KEY 一并暴露，方便测试断言「恢复区确实被删了」。 */
  Sleepy.backupApp = {
    clearEverything: clearEverything,
    importEverything: importEverything,
    resumeRestore: resumeRestore,
    RB_KEY: RB_KEY,
    /* 给冒烟读恢复区现状（键名由本模块定，测试不该自己拼字符串） */
    pendingRestore: takeRestore
  };

})(window);
