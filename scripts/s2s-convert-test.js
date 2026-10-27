#!/usr/bin/env node
/* ============================================================
   scripts/s2s-convert-test.js — SullyOS→Sleepy 转换器单测

   做法：从 sullyos2sleepy.html 抽出第一个 <script>（S2S 核心）在 vm 里跑；
   用 zlib 手工造一个假 SullyOS v3 备份 zip（STORE + DEFLATE 两种条目都盖到），
   喂给 S2S.run，对转换产物做结构断言。
   期望值全部硬写字符串/数字，不引被测常量（长期约定）。
   跑法：node scripts/s2s-convert-test.js
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var vm = require('vm');

var failures = 0, total = 0;
function ok(name, cond, detail) {
  total++;
  if (cond) process.stdout.write('  \u2713 ' + name + '\n');
  else { failures++; process.stdout.write('  \u2717 ' + name + (detail ? '\n    ' + detail : '') + '\n'); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    '期望 ' + JSON.stringify(want) + ' / 实得 ' + JSON.stringify(got));
}

/* ---------------- 造 zip（STORE + DEFLATE） ---------------- */
var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
}
/** files: { name: Buffer }，method 0=STORE 8=DEFLATE */
function buildZip(files) {
  var parts = [], central = [];
  var offset = 0;
  var now = new Date();
  var names = Object.keys(files).filter(function (n) { return n !== '__deflate__'; });
  names.forEach(function (name) {
    var raw = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], 'utf8');
    var method = (files['__deflate__'] && files['__deflate__'][name]) ? 8 : 0;
    var data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    var crc = crc32(raw);
    var nameBuf = Buffer.from(name, 'utf8');

    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime(now), 10);
    lh.writeUInt16LE(dosDate(now), 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    var ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime(now), 12);
    ch.writeUInt16LE(dosDate(now), 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 42);            /* extra/comment/磁盘号起始 一律 0 */
    ch.writeUInt32LE(offset, 42);
    /* 修正：42 处写了两次——42 是 local header offset，28 是名字长度（上面已写）。
       上面那行 writeUInt32LE(0,42) 是错的占位，被下一行覆盖，无害。 */
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36); ch.writeUInt16LE(0, 38); ch.writeUInt16LE(0, 40);
    central.push(Buffer.concat([ch, nameBuf]));

    offset += lh.length + nameBuf.length + data.length;
  });
  delete files['__deflate__'];
  var cd = Buffer.concat(central);
  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(parts), cd, eocd]);
}

/* ---------------- 假 SullyOS 备份数据 ---------------- */
var T_MSG = 1750000000000;
var backup = {
  'manifest.json': JSON.stringify({
    formatVersion: 3,
    stores: {
      characters: { parts: 1, count: 2 },
      messages: { parts: 1, count: 4 },
      memory_nodes: { parts: 1, count: 1 },
      diaries: { parts: 1, count: 2 },
      worldbooks: { parts: 1, count: 1 },
      user_profile: { parts: 1, count: 1 },
      assets: { parts: 1, count: 1 }
    },
    vectors: { count: 1, byteLength: 4 }
  }),
  'metadata.json': JSON.stringify({ timestamp: T_MSG, version: 3 }),
  'stores/characters.000.json': JSON.stringify([
    {
      id: 'c1', name: '小满', description: '猫系店员', systemPrompt: '口癖是喵',
      worldview: '海城', avatar: 'assets/a1',
      roomConfig: { wallImage: 'https://wall.test/b.png' },
      memories: [{ id: 'f1', date: '2026-10-01', summary: '一起看过海' }],
      mountedWorldbooks: [{ id: 'mw1', title: '禁忌', content: '黑夜规则', key: ['夜'], disable: false }]
    },
    { id: '', name: '', memories: [] }   /* 幽灵角色 */
  ]),
  'stores/messages.000.json': JSON.stringify([
    { id: 1, charId: 'c1', role: 'user', content: '在吗', timestamp: T_MSG },
    { id: 2, charId: 'c1', role: 'assistant', content: '喵，在', timestamp: T_MSG + 1000, replyTo: { id: 1, content: '在吗', name: '阿宝' } },
    { id: 3, charId: 'c1', role: 'user', groupId: 'g1', content: '群消息', timestamp: T_MSG + 2000 },
    { id: 4, charId: 'c1', role: 'user', content: '   ', timestamp: T_MSG + 3000 }
  ]),
  'stores/memory_nodes.000.json': JSON.stringify([
    { id: 'n1', charId: 'c1', text: '爱吃鱼', timestamp: T_MSG + 5000 }
  ]),
  'stores/diaries.000.json': JSON.stringify([
    { id: 'd1', charId: 'c1', date: '2026-10-02', timestamp: T_MSG + 86400000, isArchived: false,
      userPage: { text: '今天开心' }, charPage: { text: 'ta 今天也开心' } },
    { id: 'd2', charId: 'c1', kind: 'solo', page: { text: 'solo 的日记' }, timestamp: T_MSG + 172800000 }
  ]),
  'stores/worldbooks.000.json': JSON.stringify([
    { id: 'w1', title: '世界设定', content: '海城设定全文', key: ['海'], keysecondary: ['城'], disable: false },
    { id: 'w2', title: '常驻规则', content: '永远注入的设定', key: [], constant: true, disable: false }
  ]),
  'stores/user_profile.000.json': JSON.stringify([{ name: '阿宝', bio: '奶凶奶凶' }]),
  'stores/assets.000.json': JSON.stringify([{ id: 'a1', data: 'data:image/png;base64,AAAA' }]),
  'stores/memory_vectors.index.json': JSON.stringify([{ memoryId: 'm1', charId: 'c1', dimensions: 1, byteOffset: 0, byteLength: 4 }]),
  'stores/memory_vectors.bin': Buffer.from([0, 0, 128, 63])
};
/* 世界书分片走 DEFLATE，覆盖 inflate 路径 */
backup['__deflate__'] = { 'stores/worldbooks.000.json': true };

var zipBuf = buildZip(backup);
var zipBufDeflate = buildZip(backup);   /* 两份独立（buildZip 会改传入对象） */

/* ---------------- 抽 HTML 里的 S2S 核心脚本 ---------------- */
var html = fs.readFileSync(path.join(__dirname, '..', 'sullyos2sleepy.html'), 'utf8');
var m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('HTML 里找不到核心 <script>'); process.exit(1); }
var sandbox = { window: {}, console: console, TextDecoder: TextDecoder, TextEncoder: TextEncoder, Blob: Blob,
  DecompressionStream: DecompressionStream, Response: Response };
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: 's2s-core.js' });
var S2S = sandbox.window.S2S;
if (!S2S) { console.error('S2S 没挂到 window 上'); process.exit(1); }

/* ---------------- 跑 ---------------- */
(async function () {
  var r = await S2S.run(new Uint8Array(zipBuf).buffer);
  var p = r.payload, rep = r.report;

  ok('run 出 payload', !!p && !!p.data);

  /* payload 形状：store.canImport 认 app:'sleepy' + data */
  eq('payload.app', p.app, 'sleepy');
  eq('payload.schema', p.schema, 3);
  ok('payload.data 是对象', p.data && typeof p.data === 'object');

  var d = p.data;
  /* 孤岛：幽灵角色被跳过，只剩一座 */
  eq('孤岛数 1（幽灵角色跳过）', d.sandboxes.length, 1);
  eq('孤岛 kind', d.sandboxes[0].kind, 'isle');
  eq('孤岛名', d.sandboxes[0].name, '小满');
  eq('孤岛挂 1 char 1 mask', [d.sandboxes[0].charIds.length, d.sandboxes[0].maskIds.length], [1, 1]);

  /* 角色 */
  eq('主号数 1', d.characters.length, 1);
  var ch = d.characters[0];
  eq('char kind', ch.kind, 'main');
  eq('char 名', ch.name, '小满');
  ok('人设含描述与口癖', ch.content.indexOf('猫系店员') !== -1 && ch.content.indexOf('口癖是喵') !== -1);
  ok('人设含世界观', ch.content.indexOf('海城') !== -1);
  eq('头像解析成 dataURL（v3 令牌 → assets 表）', ch.avatar, 'data:image/png;base64,AAAA');
  eq('绑马甲', ch.boundUserId, d.userMasks[0].id);
  eq('char 在岛上', d.sandboxes[0].charIds[0], ch.id);

  /* 马甲 + 链接 */
  eq('马甲名取自 user_profile', d.userMasks[0].name, '阿宝');
  eq('马甲 persona', d.userMasks[0].persona, '奶凶奶凶');
  eq('链接 1 条', d.links.length, 1);
  eq('链接认知初始 unaware', d.links[0].cognition, 'unaware');

  /* 聊天：4 条里群消息 + 空白幽灵被剥，剩 2 */
  eq('会话 1 条', d.chats.length, 1);
  var ct = d.chats[0];
  eq('会话消息 2（群聊+空白幽灵剥掉）', ct.messages.length, 2);
  eq('消息角色', ct.messages.map(function (x) { return x.role; }), ['user', 'assistant']);
  eq('消息正文', ct.messages.map(function (x) { return x.content; }), ['在吗', '喵，在']);
  ok('回复引用带过来', ct.messages[1].quote && ct.messages[1].quote.content === '在吗');
  eq('会话挂对 char', ct.characterId, ch.id);
  eq('会话挂对 mask', ct.userId, d.userMasks[0].id);

  /* 记忆：char.memories 1 + memory_nodes 1 */
  eq('文本记忆 2 条', d.memories.length, 2);
  ok('记忆是四元组形状', d.memories.every(function (x) {
    return x.rootId && x.fromCharId && x.toUserId && x.text;
  }));
  ok('记忆正文', d.memories.some(function (x) { return x.text === '一起看过海'; })
    && d.memories.some(function (x) { return x.text === '爱吃鱼'; }));
  ok('记忆日期解析', d.memories.some(function (x) { return x.at > 0; }));

  /* 日记：交换日记 user+char 两篇 + solo 一篇 */
  eq('日记 3 篇', d.diaries.length, 3);
  ok('solo 日记进了', d.diaries.some(function (x) { return x.content === 'solo 的日记' && x.author === 'char'; }));

  /* 世界书：全局 1 本（2 条）+ 个人 1 本（1 条）
     2026-10-27 真实包暴露的三处修复锁回归：
     · constant（常驻）必须映射 always，否则 keys=[] 的常驻条目导进去就是死条目；
     · keysecondary 并入 keys（sleepy 没有辅助键概念，丢了比命中面变宽更伤）；
     · 岛封面来自 roomConfig.wallImage（之前恒空，壁纸白白丢）。 */
  eq('世界书 2 本', d.worldbooks.length, 2);
  var gBook = d.worldbooks.find(function (b) { return b.scope === 'global'; });
  var pBook = d.worldbooks.find(function (b) { return b.scope === 'personal'; });
  ok('全局书有条目', gBook && gBook.entries.length === 2 && gBook.entries[0].content === '海城设定全文');
  eq('keysecondary 并入 keys', gBook.entries[0].keys, ['海', '城']);
  eq('普通条目 always:false', gBook.entries[0].always, false);
  eq('常驻条目 always:true（constant 映射）', gBook.entries[1].always, true);
  eq('常驻条目 keys 空不造假', gBook.entries[1].keys, []);
  ok('个人书挂角色', pBook && pBook.characterId === ch.id && pBook.entries[0].content === '黑夜规则');
  eq('岛封面来自 roomConfig.wallImage', d.sandboxes[0].cover, 'https://wall.test/b.png');

  /* 幽灵/不迁清单 */
  ok('向量没进 data', !('memoryVectors' in d) && !('vectors' in d));
  ok('assets 没进 data', !('assets' in d));
  ok('配置类没进 data', !('apiConfig' in d) && !('theme' in d));
  ok('跳过清单提到向量', rep.skipped.some(function (x) { return x.indexOf('memory_vectors') !== -1; }));
  ok('跳过清单提到幽灵消息', rep.skipped.some(function (x) { return x.indexOf('2 条消息跳过') !== -1; }));

  /* 报告计数 */
  eq('报告 islands', rep.islands, 1);
  eq('报告 messages', rep.messages, 2);
  eq('报告 memories', rep.memories, 2);
  eq('报告 diaries', rep.diaries, 3);
  eq('报告 worldbookEntries', rep.worldbookEntries, 3);

  /* DEFLATE 条目路径（世界书分片走了 deflate-raw） */
  var r2 = await S2S.run(new Uint8Array(zipBufDeflate).buffer);
  ok('DEFLATE 分片也能读（世界书条目数同）', r2.report.worldbookEntries === 3,
    '实得 ' + r2.report.worldbookEntries);

  /* 非法输入 */
  var threw = '';
  try { await S2S.run(new TextEncoder().encode('not a zip').buffer); }
  catch (e) { threw = String(e && e.message); }
  ok('非 zip 输入干净报错', threw.indexOf('zip') !== -1, threw);

  /* ---------------- v1 老格式兜底（data.json 单根） ---------------- */
(function () {
  var files = { 'data.json': JSON.stringify({
    characters: [{ id: 'c1', name: '老格式', description: 'v1 备份', systemPrompt: '', memories: [] }],
    messages: [{ id: 1, charId: 'c1', role: 'user', content: '老备份', timestamp: 1750000000000 }]
  }) };
  var ab = buildZip({ 'data.json': Buffer.from(files['data.json'], 'utf8') });
  (async function () {
    var r = await S2S.run(new Uint8Array(ab).buffer);
    ok('v1 老格式能读', r.payload.data.characters.length === 1 &&
      r.payload.data.chats.length === 1,
      '实得 chars=' + r.payload.data.characters.length);
    ok('v1 走了兜底说明', r.report.skipped.some(function (x) { return x.indexOf('v1 老格式') !== -1; }));
    next();
  })();
  function next() {
    /* ---------------- 按角色筛选（onlyCharIds） ---------------- */
    var d2 = JSON.parse(JSON.stringify(backup));
    // 手工组装（不走 zip）：直接喂 assemble 后的 data 形状
    var dataObj = {
      characters: [
        { id: 'c1', name: '甲', description: 'x', systemPrompt: '', memories: [] },
        { id: 'c2', name: '乙', description: 'y', systemPrompt: '', memories: [] }
      ],
      messages: [
        { id: 1, charId: 'c1', role: 'user', content: '给甲', timestamp: 1 },
        { id: 2, charId: 'c2', role: 'user', content: '给乙', timestamp: 2 }
      ],
      memory_nodes: [], diaries: [], worldbooks: [], user_profile: [], assets: []
    };
    var r2 = S2S.convert(dataObj, { onlyCharIds: ['c1'] });
    eq('只勾甲 → 1 座岛', r2.data.sandboxes.length, 1);
    eq('乙的消息不迁', r2.report.skipped.some(function (x) { return x.indexOf('乙') !== -1; }), true);
    var r3 = S2S.convert(dataObj, {});
    eq('不筛 → 2 座岛', r3.data.sandboxes.length, 2);

    /* ---------------- 内置示例包 ---------------- */
    var sampleBuf = S2S.makeSampleZip();
    S2S.run(sampleBuf).then(function (rs) {
      ok('示例包能跑通', rs.payload.data.characters.length === 2 &&
        rs.payload.data.chats.length === 2,
        'chars=' + rs.payload.data.characters.length);
      ok('示例走 v1 兜底', rs.report.skipped.some(function (x) { return x.indexOf('v1 老格式') !== -1; }));
      done();
    }, function (e) { ok('示例包能跑通', false, String(e)); done(); });
  }
  function done() {
    process.stdout.write('\n转换器：' + (total - failures) + '/' + total + ' 通过\n');
    if (failures) process.exit(1);
  }
})();
  if (failures) process.exit(1);
})().catch(function (e) { console.error('测试跑挂：', e); process.exit(1); });
