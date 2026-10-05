/* 取证探针（仓库外落盘、本文件入仓库供复跑）：零模型零网络。
   用生产装配入口抓一份「最终 messages」证据：K03e 生活块长什么样、
   在 F1 messages 里的位置。跑法：node scripts/k03e-evidence-probe.js */
'use strict';
var H = require('./harness.js');
var h = H.boot('k03e-evidence');
var S = h.S;
var sb = S.core.createSandbox('isle', 'K03e证据岛');
S.core.setActiveSandbox(sb.id);
var ch = S.core.upsertChar({ name: '证据角色', kind: 'main' }).id;
S.core.setSandboxChars(sb.id, [ch]);
var u = S.core.upsertUser({ name: '证据我' }).id;
S.core.setSandboxMasks(sb.id, [u]);
S.taLife.add('items', { title: '相机还差一个零件', detail: '快门件到货就能装', nextCheck: '零件到货再看', status: '进行中', refCharId: ch });
S.taLife.add('promises', { quote: '周末陪你去拍胶片', toWhom: '你', condition: '等天晴', standard: '把一卷拍完', pendingWhy: '最近连着下雨', status: '待核实', refCharId: ch, refUserId: u });
S.taLife.add('follows', { target: '楼下的三花猫', latest: '上周开始没出现', reason: '它认得他', refCharId: ch });
var r = S.promptEngine.assembleOnline({
  charId: ch, userId: u,
  history: [{ role: 'user', content: '相机修得怎么样了？' }, { role: 'assistant', content: '还差个零件。' }]
});
var out = { 三表快照一致: true, messagesTotal: r.messages.length };
var idx = r.messages.map(function (m, i) { return (m.content || '').indexOf('[TA_LIFE]') >= 0 ? i : -1; }).filter(function (i) { return i >= 0; });
out.taLifeMessageIndex = idx;
out.slot = r.slots.filter(function (x) { return x.id === 'talife'; })[0];
out.taLifeBlock = idx.length ? r.messages[idx[0]].content : '(未命中)';
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
