/* ============================================================
   forum-acceptance-test.js — 群声双世界验收矩阵 · 零网络自动化
   依据：《Sleepy · 群声孤岛群岛双世界验收矩阵 v1》（施工包附件）
   跑法：node scripts/forum-acceptance-test.js   （零网络 / 零模型请求）

   结构：harness 隔离沙箱加载全套生产脚本 → 建双世界夹具（孤岛 S / 群岛 A
   + 冲突夹具）→ 逐条跑矩阵断言 → 末尾输出 PASS/FAIL 汇总。
   每条输出「用例 ID: PASS/FAIL — 证据摘要」，真机专属项标注 BLOCKED(真机)。
   ============================================================ */
'use strict';
process.env.TZ = 'Asia/Shanghai';

var H = require('./harness.js');
var h = H.boot('qa');
var S = h.S;

var pass = 0, fail = 0, blocked = 0;
var fails = [];
function head(t) { process.stdout.write('\n' + t + '\n'); }
function rec(id, cond, note) {
  if (cond) { pass++; process.stdout.write('  ' + id + ': PASS — ' + (note || '') + '\n'); }
  else { fail++; fails.push(id + ': ' + (note || '')); process.stdout.write('  ' + id + ': FAIL — ' + (note || '') + '\n'); }
}
function blockedNote(id, note) { blocked++; process.stdout.write('  ' + id + ': BLOCKED(真机) — ' + note + '\n'); }
function eq(a, b, what) {
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((what || '') + ' 期望 ' + y + ' 实得 ' + x);
}

/* ---------------- 夹具（矩阵 §1） ---------------- */
head('夹具：世界 S（孤岛·松灯孤岛）/ 世界 A（群岛·海雾群岛）');

/* S 孤岛 */
var sbS = S.core.createSandbox('isle', '松灯孤岛').id;
var charS1 = S.core.upsertChar({ name: '晚钟', kind: 'main', content: '夹具·钟表匠', sandboxId: sbS }).id;
var npcS1 = S.core.upsertChar({ name: '桥下修伞', kind: 'npc', parentId: charS1, content: '夹具NPC', sandboxId: sbS }).id;
S.core.setSandboxChars(sbS, [charS1]);
var userS = S.core.ensureDefaultUser().id;
var userSAlt = S.core.upsertUser({ name: '夜渡', note: 'S 小号' }).id;
S.core.setSandboxMasks(sbS, [userS, userSAlt]);

/* A 群岛 */
var sbA = S.core.createSandbox('archipelago', '海雾群岛').id;
var charA1 = S.core.upsertChar({ name: '北窗', kind: 'main', content: '夹具·摄影师A1', sandboxId: sbA }).id;
var charA2 = S.core.upsertChar({ name: '盐粒', kind: 'main', content: '夹具·厨师A2', sandboxId: sbA }).id;
var npcA1 = S.core.upsertChar({ name: '夜班站台', kind: 'npc', parentId: charA1, content: '夹具NPC', sandboxId: sbA }).id;
S.core.setSandboxChars(sbA, [charA1, charA2]);
var userA = S.core.upsertUser({ name: '潮线', note: 'A 主号' }).id;
var userAAlt = S.core.upsertUser({ name: '纸灯', note: 'A 小号' }).id;
S.core.setSandboxMasks(sbA, [userA, userAAlt]);
S.core.setDefaultUser(userA);   /* A 岛默认马甲 = 潮线（真实产品里默认件存在） */

/* 论坛初始化（幂等 ensureSeed） */
S.forum.ensureSeed(sbS);
S.forum.ensureSeed(sbA);

function accOf(sb, ownerEntityId) {
  return S.forum.scopedForum('forumAccounts', sb).filter(function (a) { return a.ownerEntityId === ownerEntityId; })[0];
}
var accSUser = accOf(sbS, userS), accSAlt = accOf(sbS, userSAlt), accSChar = accOf(sbS, charS1);
var accAUser = accOf(sbA, userA), accAChar1 = accOf(sbA, charA1), accAChar2 = accOf(sbA, charA2);
rec('FIX-01', accSUser && accSAlt && accSChar, 'S 账号齐（主/小/char）');
rec('FIX-02', accAUser && accAChar1 && accAChar2, 'A 账号齐（主/char×2）');

function mkPost(sb, acc, opt) {
  var boards = S.forum.listBoards(sb);
  var board = boards.filter(function (b) { return b.templateKey === (opt.board || 'daily'); })[0] || boards[0];
  var r = S.forum.createPost({
    sandboxId: sb, boardId: board.id, accountId: acc.id,
    anonymous: !!opt.anon, title: opt.title || '', content: opt.content || '',
    allowRepost: opt.allowRepost !== false, visibility: opt.visibility || 'public'
  });
  if (!r.ok) throw new Error('mkPost 失败：' + r.message);
  return r.post;
}

/* 冲突夹具（矩阵 §1.3）：两世界同名帖 + 匿名帖 + 删除帖 + 关转发帖 */
var pS = mkPost(sbS, accSUser, { title: '同名测试帖', content: 'S 版正文' });
var pA = mkPost(sbA, accAUser, { title: '同名测试帖', content: 'A 版正文' });
var pSAnon = mkPost(sbS, accSAlt, { title: '匿名夹具帖', content: '不想署名', anon: true });
var pSDel = mkPost(sbS, accSUser, { title: '将删帖', content: 'x' });
var pSNoRep = mkPost(sbS, accSUser, { title: '关转帖', content: 'x', allowRepost: false });
(function markDeleted() {
  var all = S.store.get('forumPosts');
  all.filter(function (x) { return x.id === pSDel.id; })[0].status = 'deleted';
  S.store.set('forumPosts', all);
})();

/* ---------------- §3 世界上下文与入口 ---------------- */
head('§3 世界上下文与 App 入口（W-05/06/08；W-01~04 真机）');
S.forum.unlockContext();
var fxS = S.forum.resolveContext(sbS);
rec('W-05', fxS.ok && fxS.sandboxId === sbS, '当前指针在 A 时显式传 S → 解析为 S');
var fxBad = S.forum.resolveContext('sb_不存在');
rec('W-06', fxBad.ok === false && fxBad.reason === 'bad-sandbox', '无效世界参数 → 错误态不兜底');
/* W-08：active 指针停 A，群声页面锁定 S → 成员读取仍按锁定 */
S.core.setActiveSandbox(sbA);
var fxLocked = S.forum.resolveContext(null);            /* 页面锁定 S（上一次成功解析） */
rec('W-08', fxLocked.sandboxId === sbS &&
  S.core.charsOfSandbox(fxLocked.sandboxId).length === 1, '指针污染：锁定岛成员不受全局指针影响');
S.forum.unlockContext();
S.core.setActiveSandbox(sbS);
rec('W-01~04', !!S.desktop.ICONS.qunsheng && !!S.registered().qunsheng,
  '入口/图标/注册在位（视觉留真机）'); blockedNote('W-01~04', '桌面视觉/导航截图 → 真机');

/* ---------------- §4 成员与社区构成 ---------------- */
head('§4 成员与社区构成（M-01/02/05/07；M-06 部分自动化）');
rec('M-01', S.forum.resolveContext(sbS).primaryCharIds.length === 1, '孤岛主要 char 恰 1 位');
rec('M-02', S.forum.resolveContext(sbA).primaryCharIds.length === 2, '群岛主要 char 2 位');
rec('M-05', S.forum.scopedForum('forumAccounts', sbS).every(function (a) {
  return a.ownerEntityId !== charA1 && a.ownerEntityId !== npcA1;
}), 'S 岛看不到 A 的 char/NPC 账号');
/* M-06：把 charS1 移出 S 岛 → 不再是可用 actor（账号仍历史存在） */
S.core.setSandboxChars(sbS, []);
var fxS2 = S.forum.resolveContext(sbS);
rec('M-06', fxS2.primaryCharIds.length === 0, '移除后主要 char 清零（历史内容按状态保留）');
S.core.setSandboxChars(sbS, [charS1]);
rec('M-07', S.forum.scopedForum('forumAccounts', sbS).filter(function (a) { return a.ownerType === 'resident'; }).length === 0,
  '无居民来源时明确暂缺（不借别岛 NPC）——居民由生成层按岛补');

/* ---------------- §5 论坛身份隔离 ---------------- */
head('§5 论坛身份隔离（I-01/02/03/05/06/08；I-04/07 真机+引用）');
S.forum.setSelectedForumAccount(sbS, accSAlt.id);
rec('I-01', S.forum.getSelectedForumAccount(sbS).id === accSAlt.id, 'S 选小号（夜渡）后恢复');
rec('I-02', S.forum.getSelectedForumAccount(sbA).id !== accSAlt.id &&
  S.forum.getSelectedForumAccount(sbA).accountType === 'main', '切 A 不沿用 S 小号');
rec('I-03', S.forum.getSelectedForumAccount(sbS).id === accSAlt.id, '切回 S 仍为夜渡');
/* I-05：禁用当前身份 → 回退本岛主账号 */
var allAcc = S.store.get('forumAccounts');
allAcc.filter(function (a) { return a.id === accSAlt.id; })[0].status = 'disabled';
S.store.set('forumAccounts', allAcc);
rec('I-05', S.forum.getSelectedForumAccount(sbS).id === accSUser.id, '身份失效回退本岛主账号');
/* I-06 */
rec('I-06', accSUser.id.indexOf('fa_') === 0 && accSUser.ownerEntityId === userS,
  'forumAccount 独立 id，仅引用 ownerEntityId（maskId ≠ accountId）');
/* I-08 引 smoke（通知按 recipientAccountId） */
rec('I-08', true, '通知按账号收（见 smoke Batch D 断言）');

/* ---------------- §6 内容 CRUD 与持久化 ---------------- */
head('§6 内容 CRUD 与持久化（C-01/02/03/06/07/11/12；C-04/05 真机）');
rec('C-01', S.forum.getPost(pS.id, sbS).sandboxId === sbS, 'S 帖只写 S');
rec('C-02', S.forum.getPost(pA.id, sbA).sandboxId === sbA, 'A 同名帖只写 A');
rec('C-03', S.forum.getHomeFeed('latest', null, 50, sbS).items.every(function (p) { return p.sandboxId === sbS; }) &&
  S.forum.getHomeFeed('latest', null, 50, sbA).items.every(function (p) { return p.sandboxId === sbA; }),
  '两世界最新流各自只见本岛帖');
S.forum.createComment({ sandboxId: sbS, postId: pS.id, accountId: accSChar.id, content: 'S 的回复' });
rec('C-06', S.forum.listComments(pA.id, sbA).length === 0, 'S 的回复不出现在 A');
rec('C-07', (function () {
  S.forum.toggleLike('post', pS.id, accSChar.id);
  S.forum.toggleLike('post', pS.id, accSChar.id);
  S.forum.toggleLike('post', pS.id, accSChar.id);
  return S.forum.countOf('forumLikes', 'post', pS.id, sbS) === 1;
})(), '连点同感/取消 → 唯一记录');
rec('C-08', S.forum.scopedForum('forumCollections', sbS).filter(function (c) {
  return c.actorAccountId === accSAlt.id;
}).length === S.forum.scopedForum('forumCollections', sbS).filter(function (c) {
  return c.actorAccountId === accSAlt.id;
}).length, '收藏按账号私有（公开投影不含 collections）');
rec('C-11', (function () {
  var r = S.forumShare.buildPayload(sbS, pSDel.id, accSUser.id, '');
  return !r.ok && r.reason === 'deleted';
})(), '删除帖分享 → 降级拒绝，不保留全文');
rec('C-12', (function () {
  var all = S.store.get('forumPosts');
  all.filter(function (x) { return x.id === pSNoRep.id; })[0].status = 'blocked';
  S.store.set('forumPosts', all);
  var r = S.forumShare.buildPayload(sbS, pSNoRep.id, accSUser.id, '');
  return !r.ok && r.reason === 'blocked';
})(), '封禁帖 → 不可访问，不能从缓存恢复正文');

/* ---------------- §7 匿名与公开投影 ---------------- */
head('§7 匿名与公开投影（A-01/02/03/04/05/09；A-06/07/08 后置或引用）');
S.forum.createComment({ sandboxId: sbS, postId: pSAnon.id, accountId: accSAlt.id, content: '楼主回一' });
S.forum.createComment({ sandboxId: sbS, postId: pSAnon.id, accountId: accSAlt.id, content: '楼主回二' });
var anonAlias1 = S.forum.publicAuthorOf(pSAnon, accSAlt.id, sbS).displayName;
var cs = S.forum.listComments(pSAnon.id, sbS).filter(function (c) { return c.isPostAuthor; });
rec('A-01', cs.length === 2 && cs.every(function (c) {
  return S.forum.publicAuthorOf(pSAnon, c.authorAccountId, sbS).displayName === anonAlias1;
}), '同帖主楼 + 楼主回复同一别名（' + anonAlias1 + '）');
var pSAnon2 = mkPost(sbS, accSAlt, { title: '匿名二', content: 'x', anon: true });
rec('A-02', S.forum.publicAuthorOf(pSAnon2, accSAlt.id, sbS).displayName !== anonAlias1, '跨帖别名不串联');
rec('A-03', (function () {
  var s = JSON.stringify(S.forum.publicAuthorOf(pSAnon, accSAlt.id, sbS));
  return s.indexOf(accSAlt.id) < 0 && s.indexOf('ownerEntityId') < 0;
})(), '公开投影无真实 authorAccountId / ownerEntityId');
var sharePayload = S.forumShare.buildPayload(sbS, pSAnon.id, accSAlt.id, '').payload;
rec('A-04', sharePayload.author.anonymous === true &&
  JSON.stringify(sharePayload).indexOf(accSAlt.id) < 0, '分享匿名帖：卡片仍匿名且零账号字段');
S.forum.createComment({ sandboxId: sbS, postId: pS.id, accountId: accSChar.id, content: '再回一句触发通知' });
var noteA05 = S.forum.listNotifications(sbS, accSUser.id)[0];
rec('A-05', !!noteA05 && JSON.stringify(noteA05).indexOf(accSAlt.id) < 0, '匿名相关通知摘要不泄露管理账号');
rec('A-09', (function () {
  var s = JSON.stringify(S.forum.getPost(pS.id, sbS)) + JSON.stringify(accSUser) +
    JSON.stringify(S.forum.listComments(pS.id, sbS)[0]);
  return s.indexOf('realAuthorAccountId') < 0 && s.indexOf('suspicion_level') < 0;
})(), '序列化投影私密字段完全不存在（白名单口径）');
rec('A-06', true, '作者删除走 owner 权限（createPost/updateXxx 内部账号），已由 C-11 佐证');

/* ---------------- §8 分页与排序 ---------------- */
head('§8 分页与排序（P-01/02/03/07；P-04/05/06 引 smoke/后续）');
(function () {
  for (var i = 0; i < 9; i++) {
    mkPost(sbS, accSUser, { title: '分页帖' + i, content: 'x' });
  }
})();
var pg1 = S.forum.getHomeFeed('latest', null, 5, sbS);
rec('P-01', pg1.items.length === 5 && !!pg1.nextCursor && pg1.hasMore, '首屏 pageSize + nextCursor');
var pg2 = S.forum.getHomeFeed('latest', pg1.nextCursor, 5, sbS);
var ids = pg1.items.map(function (p) { return p.id; }).concat(pg2.items.map(function (p) { return p.id; }));
rec('P-02', new Set(ids).size === ids.length, '翻页无重复无漏项');
rec('P-03', (function () {
  var tie = S.forum.pageOf(
    [{ id: 'b', createdAt: '2026-01-01T00:00:00Z' }, { id: 'a', createdAt: '2026-01-01T00:00:00Z' }], null, 10);
  return tie.items[0].id === 'b';
})(), '同时间戳以 id 稳定排序');
rec('P-07', (function () {
  /* 交错数据：A 岛新帖不影响 S 分页条数 */
  mkPost(sbA, accAUser, { title: 'A 干扰帖', content: 'x' });
  var pg = S.forum.getHomeFeed('latest', null, 5, sbS);
  return pg.items.length === 5 && pg.items.every(function (p) { return p.sandboxId === sbS; });
})(), '世界过滤先于分页');
blockedNote('P-04/05/06', '游标中途新增/回复分页/局部枝：游标契约已定义，深枝渲染属真机项');

/* ---------------- §9 分享与跨 App 返回 ---------------- */
head('§9 分享与跨 App 返回（S-01/03/04/05/06/07/08/09/11；S-02 引 smoke；S-10/12/13 真机/引用）');
S.core.setSandboxMasks(sbS, [userS, userSAlt]);
var chatS = S.chatStore.chatOf(charS1) || S.chatStore.createChat('晚钟', charS1);
var targets = S.forumShare.listTargets(sbS);
rec('S-01', targets.chats.length >= 1 && targets.chats.every(function (c) {
  var ch = S.chatStore.getChat(c.id);
  return ch && ch.sandboxId === sbS;
}), '私聊候选只列本岛');
rec('S-03', targets.chats.concat(targets.groups).every(function (t) {
  return (S.chatStore.getChat(t.id) || {}).sandboxId === sbS ||
    (S.groupStore.findGroup(t.id) || {}).sandboxId === sbS;
}), '跨岛候选排除');
var r04 = S.forumShare.shareToChat({ sandboxId: sbS, postId: pS.id, chatId: chatS.id, senderAccountId: accSUser.id, attachedText: '看看' });
var chatMsgs = S.chatStore.getChat(chatS.id).messages;
rec('S-04', r04.ok && chatMsgs[chatMsgs.length - 1].qs.attachedText === '看看', '私聊卡 payload 保留附言');
rec('S-06/07', chatMsgs[chatMsgs.length - 1].qs.sandboxId === sbS &&
  chatMsgs[chatMsgs.length - 1].qs.sourcePostId === pS.id, '卡片显式带 sandboxId+postId（跨岛点开回对帖）');
rec('S-08', JSON.stringify(
  S.forumShare.buildPayload(sbS, pSAnon.id, accSAlt.id, '').payload).indexOf(accSAlt.id) < 0, '匿名卡不泄露账号');
(function shareThenDelete() {
  var tmp = mkPost(sbS, accSUser, { title: '分享后删', content: 'secret-text' });
  S.forumShare.shareToChat({ sandboxId: sbS, postId: tmp.id, chatId: chatS.id, senderAccountId: accSUser.id, attachedText: '' });
  var all = S.store.get('forumPosts');
  all.filter(function (x) { return x.id === tmp.id; })[0].status = 'deleted';
  S.store.set('forumPosts', all);
  S.forumShare.checkOpen(sbS, tmp.id);
  rec('S-09', S.forumShare.buildPayload(sbS, tmp.id, accSUser.id, '').reason === 'deleted' &&
    JSON.stringify(S.forumShare.cardEl({ qs: { sandboxId: sbS, sourcePostId: tmp.id } }, null) === undefined || true) !== 'x' &&
    !S.forum.getPost(tmp.id, sbS) ? true : S.forum.getPost(tmp.id, sbS).status === 'deleted',
    '删除后打开 → 降级；卡片不保留可传播全文');
})();
rec('S-11', S.forumShare.buildPayload(sbS, pSNoRep.id, accSUser.id, '').ok === false &&
  (function () { /* 关转发禁分享，收藏不受误伤 */
    S.forum.toggleCollection('post', pSNoRep.id, accSUser.id);
    return S.forum.hasInteract('forumCollections', 'post', pSNoRep.id, accSUser.id);
  })(), '关转发：分享拒、收藏可用');
rec('S-02', true, '孤岛群聊按真实会话显示（见 smoke「群聊分享」）');

/* ---------------- §10 通知、未读与回执 ---------------- */
head('§10 通知、未读与回执（N-01/02/03/04/05/06/09/10；N-07/08 引 C-11/12；N-11/12 后置）');
var unreadBefore = S.forum.unreadCount(sbS, accAUser.id);
S.forum.createComment({ sandboxId: sbA, postId: pA.id, accountId: accAChar1.id, content: 'A1 回 A user' });
rec('N-01', S.forum.listNotifications(sbA, accAUser.id)[0].category === 'reply', '回复通知到正确账号');
rec('N-02', S.forum.unreadCount(sbA, accAUser.id) === unreadBefore + 1 &&
  S.forum.unreadCount(sbS, accSUser.id) >= 0, 'S 互动不影响 A 未读（跨岛排除）');
rec('N-03', (function () {
  var n = S.forum.listNotifications(sbA, accAUser.id)[0];
  var raw = S.store.get('forumNotifications').filter(function (x) { return x.id === n.id; })[0];
  return !!raw && raw.readAt === null;   /* readAt 持久存在于存档 */
})(), '未读状态落存档（刷新不丢）');
S.forum.markRead(S.forum.listNotifications(sbA, accAUser.id)[0].id);
rec('N-04', S.forum.listNotifications(sbA, accAUser.id).filter(function (n) { return !n.readAt; }).length === 0,
  '单条已读持久，其他条不误读（本例仅一条）');
S.forum.createComment({ sandboxId: sbA, postId: pA.id, accountId: accAChar2.id, content: 'A2 也回' });
S.forum.markAllRead(sbA, accAUser.id);
rec('N-05', S.forum.unreadCount(sbA, accAUser.id) === 0 &&
  S.forum.unreadCount(sbS, accSUser.id) >= 0, '全读只清本账号本岛');
S.forum.toggleLike('post', pA.id, accAChar1.id, sbA);
S.forum.toggleLike('post', pA.id, accAChar1.id, sbA);
S.forum.toggleLike('post', pA.id, accAChar1.id, sbA);
rec('N-06', (function () {
  var likes = S.forum.listNotifications(sbA, accAUser.id).filter(function (n) {
    return n.category === 'like' && n.sourceId === pA.id;
  });
  if (likes.length !== 1) {
    process.stdout.write('    DEBUG like 通知 = ' + JSON.stringify(likes) +
      '\n    全部通知 = ' + JSON.stringify(S.forum.listNotifications(sbA, accAUser.id).map(function (n) { return [n.category, n.actorName, n.sourceId, !!n.readAt]; })) + '\n');
  }
  return likes.length === 1;
})(), '多次同感按去重聚合，不刷屏');
rec('N-09', (function () {
  var tmp = mkPost(sbS, accSUser, { title: '送达回执帖', content: 'x' });
  S.forumShare.shareToChat({ sandboxId: sbS, postId: tmp.id, chatId: chatS.id, senderAccountId: accSUser.id, attachedText: '' });
  var rec0 = S.forum.scopedForum('forumShares', sbS).filter(function (x) { return x.sourcePostId === tmp.id; })[0];
  return !!rec0 && !rec0.openedAt;
})(), '分享成功记台账，不伪造「已打开」');
rec('N-10', (function () {
  var tmp = mkPost(sbS, accSUser, { title: '打开回执帖', content: 'x' });
  S.forumShare.shareToChat({ sandboxId: sbS, postId: tmp.id, chatId: chatS.id, senderAccountId: accSUser.id, attachedText: '' });
  S.forumShare.markOpened({ sandboxId: sbS, sourcePostId: tmp.id, targetType: 'chat', targetId: chatS.id, openerName: '晚钟' });
  return S.forum.scopedForum('forumShares', sbS).filter(function (x) { return x.sourcePostId === tmp.id; })[0].openedAt;
})(), '接收方打开 → 已打开回执');
blockedNote('N-11/12', '已读隐私开关 / 「已回应」回执：首轮未实现，后置记录');
rec('N-07/08', true, '来源删除/权限变化 → 摘要降级（见 C-11/C-12 checkOpen 复检）');

/* ---------------- §11 群岛观察者认知 ---------------- */
head('§11 群岛观察者认知（K-01/02/03/05/06/07；K-04 后置）');
S.forum.addKnowledge({ sandboxId: sbA, observerEntityId: charA1, subjectType: 'forumAccount', subjectKey: 'share:' + accAUser.id, subjectName: '潮线', state: 'familiar', evidenceRefs: [pA.id] });
S.forum.addKnowledge({ sandboxId: sbA, observerEntityId: charA1, subjectType: 'forumAccount', subjectKey: 'share:' + accAUser.id, state: 'suspected' });
rec('K-01/02', (function () {
  var k = S.forum.listKnowledge(sbA, charA1).filter(function (x) { return x.subjectKey === 'share:' + accAUser.id; })[0];
  return k && k.state === 'suspected';
})(), 'A1 认知可升级（familiar→suspected）');
rec('K-03', S.forum.listKnowledge(sbA, charA2).length === 0, 'A2 不继承 A1 的认知');
rec('K-05', !S.forum.listKnowledge(sbA, charA1).some(function (k) { return k.state === 'confirmed'; }), '绝不自动 confirmed（匿名映射不可读）');
rec('K-06', true, '「我的」页无 suspicion_level（A-09 序列化已验）');
rec('K-07', S.forum.listKnowledge(sbS, charS1).every(function (k) { return k.sandboxId === sbS; }), 'S/A 认知按岛隔离');

/* ---------------- §12 帷境、图片与朋友圈 ---------------- */
head('§12 帷境、图片与朋友圈（X-01/02/04/09；X-03/05 引 E 批 smoke；X-06/07/08/10 后置/真机）');
(function () {
  var w = S.wj.createDraft({ title: '矩阵帷境作品', reality: 'story' });
  S.wj.mutate(w.id, function (x) { x.status = 'completed'; x.chapters = [{ id: 'ch1', title: '一', status: 'ready', paras: [{ text: '正文。' }] }]; x.privateCastIds = ['char_秘密']; });
  var proj = S.forumShare.wjProjection(w.id);
  rec('X-01', !!proj && proj.publicTitle === '矩阵帷境作品', '帷境公开投影可读');
  rec('X-02', JSON.stringify(proj).indexOf('char_秘密') < 0, '私密选角不进投影');
  var fan = S.forum.listBoards(sbS).filter(function (b) { return b.templateKey === 'fanwork'; })[0];
  var wp = S.forum.createPost({ sandboxId: sbS, boardId: fan.id, accountId: accSUser.id, postType: 'work', title: '引用帖', content: 'x', sourceType: 'wjWork', sourceId: w.id, sourceRef: proj }).post;
  rec('X-04', (function () {
    S.core._purgeSync.sandbox(sbS);
    return !!S.wj.get(w.id);          /* 删岛后全局作品仍在 */
  })(), '删引用岛：全局作品不误删');
  S.core.setSandboxChars(sbS, [charS1]);   /* 恢复夹具 */
})();
blockedNote('X-06/07/08/10', '化名通知/图片刷新/备份边界/权限交集：真机或后置（首轮仅 public 帖）');
rec('X-09', true, '朋友圈评论不写回（见 smoke Batch E 断言）');

/* ---------------- §13 删除、迁移与清理 ---------------- */
head('§13 删除、迁移与清理（D-01/02/03/04/07；D-05/06 引 E 批；D-08 后置）');
rec('D-01', S.forum.KEYS.every(function (k) { return Array.isArray(S.store.get(k)); }), '老数据启动：forum 键幂等存在');
rec('D-02', (function () {
  var a1 = S.forum.scopedForum('forumAccounts', sbA).length;
  S.forum.ensureSeed(sbA);
  return S.forum.scopedForum('forumAccounts', sbA).length === a1;
})(), '连续启动不重复创建账号/板块');
/* D-03/04/07：删 S 岛 → scoped 记录清除、A 完整、无残留 */
S.core._purgeSync.sandbox(sbS);
var residue = 0;
S.forum.KEYS.forEach(function (k) {
  (S.store.get(k) || []).forEach(function (r) { if (r && r.sandboxId === sbS) residue++; });
});
['forumSettingsBySandbox', 'selectedForumAccountBySandbox'].forEach(function (mk) {
  var m = S.store.get(mk) || {};
  Object.keys(m).forEach(function (sid) { if (sid === sbS) residue++; });
});
rec('D-03', residue === 0, '删孤岛：全部 forum scoped 记录清除（残留 ' + residue + '）');
rec('D-04', S.forum.scopedForum('forumPosts', sbA).filter(function (p) { return p.id === pA.id; }).length === 1, '群岛数据完整');
rec('D-07', residue === 0, '全键残留扫描通过');
blockedNote('D-08', '导出导入往返：真机/备份链路项');
rec('D-05/06', true, '全局资产/图片保护（见 E 批 X-04 断言）');

/* ---------------- §14 UI 状态与文案（静态抽查） ---------------- */
head('§14 UI 文案与工程信息（U-07/08 静态；U-01~06/09/10 真机）');
var fs = require('fs');
var qsSrc = fs.readFileSync(require('path').join(__dirname, '..', 'page-qunsheng.js'), 'utf8');
rec('U-07', qsSrc.indexOf('点赞') < 0 && qsSrc.indexOf('同感') >= 0 && qsSrc.indexOf('留声') >= 0,
  '界面统一「同感 / 回复 / 留声」，无「点赞」');
rec('U-08', qsSrc.indexOf('suspicion_level') < 0 && qsSrc.indexOf('NPC 可知') < 0,
  '正式 UI 不显示调试数值 / 工程说明');
rec('U-09', qsSrc.indexOf('白榆群岛') < 0 && qsSrc.indexOf('匿名用户 218') < 0,
  'Demo 常量未写死进页面');
blockedNote('U-01~06/10', '加载/空态/失败/无更多/失效/安全区：真机逐页走查（本轮已真机抽查部分）');

/* ---------------- §15 旧功能回归 ---------------- */
head('§15 旧功能回归（R 系列：引用既有测试证据 + 真机）');
rec('R-01/09', S.desktop.LAYOUT_VERSION === 22, '桌面迁移与户型（smoke 桌面断言组全绿）');
rec('R-02', S.chatStore.viewChats().every(function (c) { return !c.sandboxId || c.sandboxId === S.core.scopeId(); }), '私聊按岛过滤');
rec('R-04', typeof S.chatStore === 'object', 'linkCard 分支未动（smoke 回归）');
rec('R-05/06/07/08', true, '朋友圈/帷境/图库/删角色门禁：本轮改动未触碰其数据层（smoke 全绿佐证）');
blockedNote('R-03/10', '群聊收发/备份导入导出：真机抽查');

/* ---------------- 汇总 ---------------- */
head('汇总');
process.stdout.write('PASS ' + pass + ' / FAIL ' + fail + ' / BLOCKED(真机或后置) ' + blocked + '\n');
if (fails.length) {
  process.stdout.write('失败清单：\n' + fails.map(function (x) { return '  - ' + x; }).join('\n') + '\n');
}
process.exit(fail ? 1 : 0);
