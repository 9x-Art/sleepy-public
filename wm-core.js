/* ============================================================
   wm-core.js — 文字麻将 · 纯逻辑引擎（P0，自 SullyOS utils/wordMahjong 移植）

   「文字打马吊」1v1：用户 vs TA，互相当裁判。
     · 各 13 张起手；每回合先摸 1 张
     · 把手里 ≥3 个字组成短句**整句打出**清牌；手牌先出空者赢
     · 出句后由对方判——全部通过 / 部分通过 / 全部打回
     · 裁判是 LLM（牌局上下文注入 + 回复标签解析，接点在 page-chat.js），
       本文件只提供纯操作与 TA 本地兜底选牌。

   红线：本文件**零依赖**（不碰 store / DOM / fetch）——
   引擎是纯函数，Node 单测（scripts/wm-core-test.js）直接 require 就能跑。
   状态落库挂在 chat 对象的 c.wm 上（写入走 page-chat 的 mutate，
   别在模块里缓存整局对象——store.get 是深拷贝，改缓存等于没写）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* ---------------- 牌库（144 张高频汉字，7 大词类） ----------------
     牌面数据逐字移植自 MIT 项目 jin-s13/WordMahjong（CardLibraryService
     默认牌库）。id 用「类别+序号」确定性生成，洗牌后引用同一实例。 */

  var RAW_TILES = [
    // 情感核心字（10张）
    { char: '我', category: 'emotion', pinyin: 'wǒ', frequency: 5 },
    { char: '我', category: 'emotion', pinyin: 'wǒ', frequency: 5 },
    { char: '你', category: 'emotion', pinyin: 'nǐ', frequency: 5 },
    { char: '你', category: 'emotion', pinyin: 'nǐ', frequency: 5 },
    { char: '爱', category: 'emotion', pinyin: 'ài', frequency: 4 },
    { char: '爱', category: 'emotion', pinyin: 'ài', frequency: 4 },
    { char: '家', category: 'emotion', pinyin: 'jiā', frequency: 4 },
    { char: '家', category: 'emotion', pinyin: 'jiā', frequency: 4 },
    { char: '心', category: 'emotion', pinyin: 'xīn', frequency: 4 },
    { char: '心', category: 'emotion', pinyin: 'xīn', frequency: 4 },

    // 高频动词（28张）
    { char: '吃', category: 'verb', pinyin: 'chī', frequency: 5 },
    { char: '吃', category: 'verb', pinyin: 'chī', frequency: 5 },
    { char: '说', category: 'verb', pinyin: 'shuō', frequency: 5 },
    { char: '说', category: 'verb', pinyin: 'shuō', frequency: 5 },
    { char: '想', category: 'verb', pinyin: 'xiǎng', frequency: 5 },
    { char: '想', category: 'verb', pinyin: 'xiǎng', frequency: 5 },
    { char: '看', category: 'verb', pinyin: 'kàn', frequency: 4 },
    { char: '听', category: 'verb', pinyin: 'tīng', frequency: 4 },
    { char: '走', category: 'verb', pinyin: 'zǒu', frequency: 4 },
    { char: '跑', category: 'verb', pinyin: 'pǎo', frequency: 4 },
    { char: '跳', category: 'verb', pinyin: 'tiào', frequency: 4 },
    { char: '飞', category: 'verb', pinyin: 'fēi', frequency: 4 },
    { char: '游', category: 'verb', pinyin: 'yóu', frequency: 4 },
    { char: '唱', category: 'verb', pinyin: 'chàng', frequency: 3 },
    { char: '跳', category: 'verb', pinyin: 'tiào', frequency: 3 },
    { char: '学', category: 'verb', pinyin: 'xué', frequency: 4 },
    { char: '工', category: 'verb', pinyin: 'gōng', frequency: 3 },
    { char: '思', category: 'verb', pinyin: 'sī', frequency: 3 },
    { char: '创', category: 'verb', pinyin: 'chuàng', frequency: 3 },
    { char: '想', category: 'verb', pinyin: 'xiǎng', frequency: 3 },
    { char: '做', category: 'verb', pinyin: 'zuò', frequency: 4 },
    { char: '打', category: 'verb', pinyin: 'dǎ', frequency: 4 },
    { char: '开', category: 'verb', pinyin: 'kāi', frequency: 4 },
    { char: '关', category: 'verb', pinyin: 'guān', frequency: 4 },
    { char: '拿', category: 'verb', pinyin: 'ná', frequency: 3 },
    { char: '放', category: 'verb', pinyin: 'fàng', frequency: 3 },
    { char: '买', category: 'verb', pinyin: 'mǎi', frequency: 3 },
    { char: '卖', category: 'verb', pinyin: 'mài', frequency: 3 },

    // 日常名词（40张）
    { char: '饭', category: 'noun', pinyin: 'fàn', frequency: 5 },
    { char: '菜', category: 'noun', pinyin: 'cài', frequency: 4 },
    { char: '肉', category: 'noun', pinyin: 'ròu', frequency: 4 },
    { char: '鱼', category: 'noun', pinyin: 'yú', frequency: 4 },
    { char: '蛋', category: 'noun', pinyin: 'dàn', frequency: 4 },
    { char: '米', category: 'noun', pinyin: 'mǐ', frequency: 4 },
    { char: '面', category: 'noun', pinyin: 'miàn', frequency: 4 },
    { char: '包', category: 'noun', pinyin: 'bāo', frequency: 3 },
    { char: '饺', category: 'noun', pinyin: 'jiǎo', frequency: 3 },
    { char: '汤', category: 'noun', pinyin: 'tāng', frequency: 3 },
    { char: '水', category: 'noun', pinyin: 'shuǐ', frequency: 5 },
    { char: '茶', category: 'noun', pinyin: 'chá', frequency: 4 },
    { char: '酒', category: 'noun', pinyin: 'jiǔ', frequency: 3 },
    { char: '牛', category: 'noun', pinyin: 'niú', frequency: 3 },
    { char: '咖', category: 'noun', pinyin: 'kā', frequency: 3 },
    { char: '桌', category: 'noun', pinyin: 'zhuō', frequency: 3 },
    { char: '椅', category: 'noun', pinyin: 'yǐ', frequency: 3 },
    { char: '窗', category: 'noun', pinyin: 'chuāng', frequency: 3 },
    { char: '门', category: 'noun', pinyin: 'mén', frequency: 4 },
    { char: '床', category: 'noun', pinyin: 'chuáng', frequency: 3 },
    { char: '灯', category: 'noun', pinyin: 'dēng', frequency: 3 },
    { char: '书', category: 'noun', pinyin: 'shū', frequency: 4 },
    { char: '笔', category: 'noun', pinyin: 'bǐ', frequency: 3 },
    { char: '纸', category: 'noun', pinyin: 'zhǐ', frequency: 3 },
    { char: '钱', category: 'noun', pinyin: 'qián', frequency: 4 },
    { char: '包', category: 'noun', pinyin: 'bāo', frequency: 3 },
    { char: '衣', category: 'noun', pinyin: 'yī', frequency: 3 },
    { char: '鞋', category: 'noun', pinyin: 'xié', frequency: 3 },
    { char: '猫', category: 'noun', pinyin: 'māo', frequency: 3 },
    { char: '狗', category: 'noun', pinyin: 'gǒu', frequency: 3 },
    { char: '花', category: 'noun', pinyin: 'huā', frequency: 3 },
    { char: '草', category: 'noun', pinyin: 'cǎo', frequency: 3 },
    { char: '树', category: 'noun', pinyin: 'shù', frequency: 3 },
    { char: '山', category: 'noun', pinyin: 'shān', frequency: 3 },
    { char: '海', category: 'noun', pinyin: 'hǎi', frequency: 3 },
    { char: '天', category: 'noun', pinyin: 'tiān', frequency: 4 },
    { char: '日', category: 'noun', pinyin: 'rì', frequency: 3 },
    { char: '月', category: 'noun', pinyin: 'yuè', frequency: 3 },
    { char: '风', category: 'noun', pinyin: 'fēng', frequency: 3 },
    { char: '云', category: 'noun', pinyin: 'yún', frequency: 3 },

    // 形容词（20张）
    { char: '好', category: 'adjective', pinyin: 'hǎo', frequency: 5 },
    { char: '美', category: 'adjective', pinyin: 'měi', frequency: 4 },
    { char: '香', category: 'adjective', pinyin: 'xiāng', frequency: 4 },
    { char: '甜', category: 'adjective', pinyin: 'tián', frequency: 4 },
    { char: '快', category: 'adjective', pinyin: 'kuài', frequency: 4 },
    { char: '慢', category: 'adjective', pinyin: 'màn', frequency: 3 },
    { char: '大', category: 'adjective', pinyin: 'dà', frequency: 4 },
    { char: '小', category: 'adjective', pinyin: 'xiǎo', frequency: 4 },
    { char: '多', category: 'adjective', pinyin: 'duō', frequency: 4 },
    { char: '少', category: 'adjective', pinyin: 'shǎo', frequency: 3 },
    { char: '新', category: 'adjective', pinyin: 'xīn', frequency: 3 },
    { char: '旧', category: 'adjective', pinyin: 'jiù', frequency: 3 },
    { char: '暖', category: 'adjective', pinyin: 'nuǎn', frequency: 3 },
    { char: '冷', category: 'adjective', pinyin: 'lěng', frequency: 3 },
    { char: '喜', category: 'adjective', pinyin: 'xǐ', frequency: 3 },
    { char: '乐', category: 'adjective', pinyin: 'lè', frequency: 3 },
    { char: '安', category: 'adjective', pinyin: 'ān', frequency: 3 },
    { char: '康', category: 'adjective', pinyin: 'kāng', frequency: 3 },
    { char: '顺', category: 'adjective', pinyin: 'shùn', frequency: 3 },
    { char: '旺', category: 'adjective', pinyin: 'wàng', frequency: 3 },

    // 副词+虚词+语气词（19张）
    { char: '的', category: 'adverb', pinyin: 'de', frequency: 5 },
    { char: '的', category: 'adverb', pinyin: 'de', frequency: 5 },
    { char: '了', category: 'adverb', pinyin: 'le', frequency: 5 },
    { char: '了', category: 'adverb', pinyin: 'le', frequency: 5 },
    { char: '就', category: 'adverb', pinyin: 'jiù', frequency: 4 },
    { char: '就', category: 'adverb', pinyin: 'jiù', frequency: 4 },
    { char: '也', category: 'adverb', pinyin: 'yě', frequency: 4 },
    { char: '也', category: 'adverb', pinyin: 'yě', frequency: 4 },
    { char: '很', category: 'adverb', pinyin: 'hěn', frequency: 4 },
    { char: '太', category: 'adverb', pinyin: 'tài', frequency: 4 },
    { char: '真', category: 'adverb', pinyin: 'zhēn', frequency: 4 },
    { char: '都', category: 'adverb', pinyin: 'dōu', frequency: 4 },
    { char: '只', category: 'adverb', pinyin: 'zhǐ', frequency: 3 },
    { char: '还', category: 'adverb', pinyin: 'hái', frequency: 3 },
    { char: '啊', category: 'adverb', pinyin: 'a', frequency: 3 },
    { char: '呀', category: 'adverb', pinyin: 'ya', frequency: 3 },
    { char: '吧', category: 'adverb', pinyin: 'ba', frequency: 3 },
    { char: '吗', category: 'adverb', pinyin: 'ma', frequency: 3 },
    { char: '呢', category: 'adverb', pinyin: 'ne', frequency: 3 },

    // 场景/方位字（19张）
    { char: '家', category: 'scene', pinyin: 'jiā', frequency: 4 },
    { char: '校', category: 'scene', pinyin: 'xiào', frequency: 3 },
    { char: '店', category: 'scene', pinyin: 'diàn', frequency: 3 },
    { char: '园', category: 'scene', pinyin: 'yuán', frequency: 3 },
    { char: '厨', category: 'scene', pinyin: 'chú', frequency: 3 },
    { char: '厅', category: 'scene', pinyin: 'tīng', frequency: 3 },
    { char: '房', category: 'scene', pinyin: 'fáng', frequency: 3 },
    { char: '里', category: 'scene', pinyin: 'lǐ', frequency: 4 },
    { char: '外', category: 'scene', pinyin: 'wài', frequency: 4 },
    { char: '上', category: 'scene', pinyin: 'shàng', frequency: 4 },
    { char: '下', category: 'scene', pinyin: 'xià', frequency: 4 },
    { char: '左', category: 'scene', pinyin: 'zuǒ', frequency: 3 },
    { char: '右', category: 'scene', pinyin: 'yòu', frequency: 3 },
    { char: '前', category: 'scene', pinyin: 'qián', frequency: 3 },
    { char: '后', category: 'scene', pinyin: 'hòu', frequency: 3 },
    { char: '东', category: 'scene', pinyin: 'dōng', frequency: 3 },
    { char: '南', category: 'scene', pinyin: 'nán', frequency: 3 },
    { char: '西', category: 'scene', pinyin: 'xī', frequency: 3 },
    { char: '北', category: 'scene', pinyin: 'běi', frequency: 3 },

    // 补充融合字（8张）
    { char: '一', category: 'supplement', pinyin: 'yī', frequency: 5 },
    { char: '一', category: 'supplement', pinyin: 'yī', frequency: 5 },
    { char: '二', category: 'supplement', pinyin: 'èr', frequency: 4 },
    { char: '三', category: 'supplement', pinyin: 'sān', frequency: 4 },
    { char: '不', category: 'supplement', pinyin: 'bù', frequency: 5 },
    { char: '不', category: 'supplement', pinyin: 'bù', frequency: 5 },
    { char: '是', category: 'supplement', pinyin: 'shì', frequency: 5 },
    { char: '是', category: 'supplement', pinyin: 'shì', frequency: 5 }
  ];

  /** 生成一整副牌（id 确定性：类别-序号） */
  function buildDeck() {
    return RAW_TILES.map(function (t, i) {
      return { id: t.category + '-' + i, char: t.char, category: t.category, pinyin: t.pinyin, frequency: t.frequency };
    });
  }

  /** Fisher–Yates 洗牌（不改变原数组） */
  function shuffle(cards) {
    var arr = cards.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  /** 1v1 发牌：各 13 张，其余进牌墙 */
  function dealForTwo(deck) {
    var wall = shuffle(deck);
    var hand0 = wall.splice(0, 13);
    var hand1 = wall.splice(0, 13);
    return { hands: [hand0, hand1], wall: wall };
  }

  /* ---------------- 本地兜底判词 ---------------- */

  var COMMON_WORDS = [
    '我们', '爱你', '想你', '心里', '心爱',
    '吃饭', '想吃', '爱吃', '好吃', '喝汤', '米汤', '蛋汤', '面汤',
    '看书', '好看', '想看', '爱看', '听书', '好书',
    '走路', '快走', '慢走', '快跑', '慢跑', '跑跳', '飞跑',
    '飞天', '游水', '游海', '学飞', '学走', '学唱', '学工', '学话',
    '唱跳', '想唱', '歌唱', '想听',
    '工作', '开工', '打工', '想做', '想买', '想家', '想说', '想做',
    '打开', '开门', '开灯', '开窗', '开店', '关门', '关灯', '关窗',
    '拿书', '放书', '买花', '买书', '买衣', '买鞋', '卖花',
    '米饭', '饭菜', '菜肉', '牛肉', '鱼肉', '面包', '饺汤', '咖汤', '汤面',
    '茶水', '酒水', '水牛', '牛奶', '牛气',
    '书桌', '桌椅', '门窗', '窗门', '纸笔', '笔纸', '钱包', '书包',
    '衣鞋', '花猫', '小狗', '猫狗', '花草', '花树', '草地', '树木', '草花',
    '山海', '海天', '天日', '日月', '风云', '风月', '云天', '东风', '南风', '北风',
    '美好', '美酒', '香甜', '快慢', '大小', '多少', '新旧', '冷暖', '喜乐', '安康', '顺心', '旺家',
    '太好', '真好', '很好', '就好', '都好', '还好', '不快', '不说', '不想', '不是', '不买', '不走',
    '我家', '你家', '大家', '家里', '校园', '店门', '园门', '厨房', '客厅', '房间', '房门', '家门',
    '外面', '门外', '窗外', '床上', '灯下', '桌上', '天上', '海上', '山上', '心里',
    '上下', '左右', '前后', '里外', '东南', '南北', '东西', '东家',
    '一天', '三天', '二天', '一日', '一月', '一山', '一心', '一手',
    '我爱你', '你爱我', '我想你', '你想我', '我想家', '爱吃吗', '吃面吗', '看书吗',
    '真好吃', '太好吃', '好开心', '小猫咪', '小狗狗', '小猫', '小狗',
    '牛肉面', '鸡蛋面', '太阳花', '满天星', '老电影',
    '好不好', '美不美', '香不香', '甜不甜', '快不快', '多不多', '大不大', '小不小',
    '一点点', '一天天', '一起走', '一起吃', '一起看', '一起玩', '给你睡', '给它们',
    '像老电影', '被饿飞', '老电影后', '给它们睡'
  ];

  var WORD_SET = new Set(COMMON_WORDS);

  function isKnownPhrase(text) {
    return text.length >= 3 && WORD_SET.has(text);
  }

  /** 句子里是否包含任一词库词 */
  function containsKnownWord(text) {
    if (text.length < 2) return false;
    for (var w of WORD_SET) {
      if (w.length >= 2 && text.indexOf(w) !== -1) return true;
    }
    return false;
  }

  /** 通顺度：相邻二字窗口命中词库的比例（整句命中 = 1） */
  function coherenceScore(text) {
    if (text.length < 2) return 0;
    if (WORD_SET.has(text)) return 1;
    var hit = 0;
    var windows = text.length - 1;
    for (var i = 0; i < windows; i++) {
      if (WORD_SET.has(text.slice(i, i + 2))) hit++;
    }
    return hit / windows;
  }

  /** 本地综合判（兜底用）：词库词包含 / bigram 命中率高 */
  function judgePhrase(text) {
    if (text.length < 3) return { ok: false, score: 0 };
    var score = coherenceScore(text);
    if (isKnownPhrase(text) || containsKnownWord(text) || score >= 0.5) {
      return { ok: true, score: Math.max(score, containsKnownWord(text) ? 0.6 : score) };
    }
    return { ok: false, score: score };
  }

  /* ---------------- 纯操作 ---------------- */

  var logSeq = 0;
  function mkLog(who, text) {
    return { id: 'wm-log-' + Date.now() + '-' + (logSeq++), who: who, text: text, timestamp: Date.now() };
  }

  function addLog(s, who, text) {
    s.log = s.log.concat([mkLog(who, text)]).slice(-80);
  }

  function cloneState(s) {
    return {
      chatId: s.chatId,
      status: s.status,
      turn: s.turn,
      hands: [s.hands[0].slice(), s.hands[1].slice()],
      melds: [s.melds[0].slice(), s.melds[1].slice()],
      wall: s.wall.slice(),
      winner: s.winner,
      isDraw: s.isDraw,
      winningSentence: s.winningSentence,
      log: s.log.slice(),
      drawnThisTurn: s.drawnThisTurn
    };
  }

  /** 谁在牌桌上：0 = user，1 = TA（宽松：对话中游戏，回合仅作提示） */
  function createGame(chatId, charName) {
    var dealt = dealForTwo(buildDeck());
    var s = {
      chatId: chatId,
      status: 'playing',
      turn: 0,
      hands: dealt.hands,
      melds: [[], []],
      wall: dealt.wall,
      winner: null,
      isDraw: false,
      winningSentence: '',
      log: [],
      drawnThisTurn: false
    };
    addLog(s, 'system', '和 ' + charName + ' 开桌！各 13 张，手牌先出空的赢。互相当裁判，胡说八道会被打回哦');
    return s;
  }

  /** 摸 1 张；牌墙空 → 结算（剩牌少者胜，平流局）。 */
  function drawCard(s, who) {
    if (s.status !== 'playing') return s;
    var next = cloneState(s);
    if (next.wall.length === 0) return endByWall(next);
    var card = next.wall[0];
    next.wall = next.wall.slice(1);
    next.hands[who].push(card);
    next.drawnThisTurn = true;
    addLog(next, 'system', who === 0 ? ('你摸到了「' + card.char + '」') : 'ta 摸了一张牌');
    return next;
  }

  /**
   * 打出一句**已被裁判通过**的短语：从手牌清掉这些牌、进组合区。
   * 全部清空 → 获胜。调用方负责先拿到裁判结果。
   */
  function playPhrase(s, who, tiles, sentence) {
    if (s.status !== 'playing') return s;
    var next = cloneState(s);
    for (var i = 0; i < tiles.length; i++) {
      var idx = -1;
      for (var j = 0; j < next.hands[who].length; j++) {
        if (next.hands[who][j].id === tiles[i].id) { idx = j; break; }
      }
      if (idx !== -1) next.hands[who].splice(idx, 1);
    }
    next.melds[who].push(tiles.slice());
    addLog(next, who === 0 ? 'user' : 'char', '打出「' + sentence + '」（' + tiles.length + ' 张）');
    if (next.hands[who].length === 0) {
      next.status = 'finished';
      next.winner = who;
      next.winningSentence = sentence;
      addLog(next, 'system', who === 0 ? '手牌出空——你赢啦！' : 'ta 手牌出空——ta 赢了');
    }
    return next;
  }

  /** 回合结束，换边（下一位开局要先摸牌） */
  function endTurn(s) {
    if (s.status !== 'playing') return s;
    var next = cloneState(s);
    next.turn = next.turn === 0 ? 1 : 0;
    next.drawnThisTurn = false;
    return next;
  }

  /** 牌墙摸完：剩牌少者胜，平流局 */
  function endByWall(s) {
    var next = cloneState(s);
    var u = next.hands[0].length, c = next.hands[1].length;
    next.status = 'finished';
    if (u < c) { next.winner = 0; addLog(next, 'system', '牌墙摸完了！你剩 ' + u + ' 张、ta 剩 ' + c + ' 张——你赢啦'); }
    else if (c < u) { next.winner = 1; addLog(next, 'system', '牌墙摸完了！你剩 ' + u + ' 张、ta 剩 ' + c + ' 张——ta 赢了'); }
    else { next.isDraw = true; addLog(next, 'system', '牌墙摸完且剩牌一样多，流局～'); }
    return next;
  }

  /** 从一句被判 partial 的句子里摘出通过的子串对应的牌（找不到就忽略该词） */
  function tilesForPassWords(played, passWords) {
    var accepted = [];
    var used = new Set();
    for (var k = 0; k < passWords.length; k++) {
      var w = passWords[k];
      for (var i = 0; i + w.length <= played.length; i++) {
        var seg = played.slice(i, i + w.length);
        var joined = seg.map(function (c) { return c.char; }).join('');
        var hitUsed = seg.some(function (c) { return used.has(c.id); });
        if (joined === w && !hitUsed) {
          seg.forEach(function (c) { accepted.push(c); used.add(c.id); });
          break;
        }
      }
    }
    return { accepted: accepted, sentence: accepted.map(function (c) { return c.char; }).join('') };
  }

  /* ---------------- TA 本地兜底选牌（LLM 失败时用） ---------------- */

  /** 从 TA 手里挑一个能通过本地判的短语；挑不到返回 null */
  function charHeuristicPick(hand) {
    var n = hand.length;
    var best = null;
    for (var len = Math.min(4, n); len >= 3; len--) {
      var idx = [];
      var dfs = function (start) {
        if (best && best.score >= 1) return;
        if (idx.length === len) {
          var sentence = idx.map(function (i) { return hand[i].char; }).join('');
          var v = judgePhrase(sentence);
          if (v.ok && (!best || v.score > best.score)) {
            best = { tiles: idx.map(function (i) { return hand[i]; }), sentence: sentence, score: v.score };
          }
          return;
        }
        for (var i = start; i < n; i++) { idx.push(i); dfs(i + 1); idx.pop(); }
      };
      dfs(0);
      if (best) break;
    }
    return best;
  }

  /* ---------------- 导出 ---------------- */

  Sleepy.wm = {
    buildDeck: buildDeck,
    shuffle: shuffle,
    dealForTwo: dealForTwo,
    judgePhrase: judgePhrase,
    coherenceScore: coherenceScore,
    isKnownPhrase: isKnownPhrase,
    containsKnownWord: containsKnownWord,
    createGame: createGame,
    drawCard: drawCard,
    playPhrase: playPhrase,
    endTurn: endTurn,
    endByWall: endByWall,
    tilesForPassWords: tilesForPassWords,
    charHeuristicPick: charHeuristicPick,
    cloneState: cloneState,
    /* 上下文注入块（P1 接 page-chat.buildMessages）：牌局进行中才给，其他返回 '' */
    buildContext: buildContext,
    /* 标签解析（P3 接回复链）：从 TA 回复里解析 WM 标签并返回剥净正文 + 动作 */
    parseWmTags: parseWmTags,
    stripWmTags: stripWmTags
  };

  /* ---------------- 上下文注入块（对齐 SullyOS chatPipeline.buildWmChatContext） ---------------- */

  /**
   * 牌局上下文（每轮垫进 prompt，贴着历史后面）。
   * nameMap: { user: 用户名, char: TA 名字 }；wm 是 chat.wm（{ game, pending, charLastPlay }）。
   * 牌局不在 / 不属于这个对话 / 已终局 → 返回 ''。
   */
  function buildContext(chatId, wm, names) {
    if (!wm || !wm.game) return '';
    var g = wm.game;
    if (g.chatId !== chatId || g.status !== 'playing') return '';
    var userName = (names && names.user) || '我';
    var charName = (names && names.char) || 'TA';

    var myHand = g.hands[1].map(function (c) { return c.char; }).join('、') || '（空）';
    var meldsU = g.melds[0].map(function (m) { return m.map(function (c) { return c.char; }).join(''); }).join('、') || '（还没有）';
    var meldsC = g.melds[1].map(function (m) { return m.map(function (c) { return c.char; }).join(''); }).join('、') || '（还没有）';

    var pendingBlock;
    if (wm.pending) {
      pendingBlock = '【⏳ 待你裁决】注意：「' + wm.pending.sentence + '」是 **' + userName + ' 打出的牌**，不是你打的！你现在当裁判，在回复里自然接住 ta 的话，并夹一个裁决标签：\n' +
        '- 整句认可 → [[WM_PASS]]\n' +
        '- 只认可部分 → [[WM_PARTIAL:认可的子串1|子串2]]（必须是句子里连续的一段、≥2 字）\n' +
        '- 不认可 → [[WM_REJECT]]\n' +
        '- 想先聊聊再判 → 不带标签就行';
    } else if (wm.charLastPlay) {
      pendingBlock = '【⏳ 等 ta 裁决】你刚打出「' + wm.charLastPlay.sentence + '」，' + userName + ' 还没判——**本轮别出牌也别摸牌**，正常聊天等 ta 判就好，别重复夹 [[WM_PLAY]]。';
    } else {
      pendingBlock = '【出牌机会】轮到你出牌了：在回复里夹 [[WM_PLAY:字|字|字]]（3~5 个、按语序、必须是你手里的字）。先把手里全部 ' + g.hands[1].length + ' 个字扫一遍找连不成句的散牌——**能组就别怂，4~5 字大句一次清光才是狠人**，实在凑不出才不带标签聊两句。';
    }

    return '【🀄 文字麻将牌局（进行中）】\n' +
      '你们在玩"文字打马吊"：牌面全是汉字，每回合摸 1 张，把手里 ≥3 个字拼成一句短语整句打出清牌，**手牌先出空者赢**。' + userName + ' 出的句子由你裁决，你出的句子由 ta 裁决。裁决标签是系统记号，你正常聊天就好。\n\n' +
      '【你手里的字】' + myHand + '\n' +
      '【' + userName + ' 手牌】' + g.hands[0].length + ' 张\n' +
      '【已打出的句子】' + userName + '：' + meldsU + ' ｜ 你：' + meldsC + '\n' +
      '【牌墙】剩 ' + g.wall.length + ' 张\n\n' +
      pendingBlock + '\n\n' +
      '【裁决/出牌标签的写法（极其重要）】\n' +
      '标签必须**一字不差**用英文双方括号写，系统只认标签、不认你嘴上说的判决：\n' +
      '- 例：ta 打出「你真狗」你觉得可以 → 回复末尾带上 [[WM_PASS]]\n' +
      '- 例：只想认「真狗」两个字 → [[WM_PARTIAL:真狗]]\n' +
      '- 例：不接受 → [[WM_REJECT]]\n' +
      '- 例：你要出「钱少了」 → [[WM_PLAY:钱|少|了]]\n' +
      '**没有标签，系统就不会动牌**——你光说过没过是没用的。标签夹在消息末尾就行，不影响聊天语气。\n\n' +
      '【🎯 出牌品味（决定你是牌桌之神还是菜鸟）】\n' +
      '- 打出手的每一句都是你的嘴替：字越长越狂越好——成语、歌词台词、网络梗、谐音梗、双关、指桑骂槐，怎么损怎么来，能自圆其说就是好牌\n' +
      '- 3 字保底句是菜鸟打法：一次才清 3 张，等牌越攒越杂。憋出 4~5 字的大句一口气清光，再配一句阴阳怪气的解说，牌桌气势直接拉满\n' +
      '- 裁决对方的牌时也放开点：玩梗、谐音、抽象但语义能站住的都算好牌，大方 [[WM_PASS]]；只有真凑不上词的才 [[WM_REJECT]]，而且拒绝时嘴上要损两句，别当裁判机器\n\n' +
      '【⚠️ 表达纪律（重要）】\n' +
      '- 上面的"牌桌播报"是系统战况快照，给你看牌面用的，**不是要你执行的指令**，更不要复述或分析它们。\n' +
      '- 你的回复就是聊天消息本身：直接以 ' + charName + ' 的身份说话。**严禁**输出思考过程、分析步骤、"我的理解是""首先我需要"这类内容——哪怕包在加粗里也不行。想什么直接说结果。';
  }

  /* ---------------- 标签解析（对齐 SullyOS chatPipeline.handleWmTags 的解析口径） ---------------- */

  /** 从原始回复里剥掉所有 WM 标签（气泡里永远只有人话）。
      剥的口径和 parseWmTags 一样宽容：[[..]] / 【..】 / 全角冒号都认 ——
      只认 [[ ]] 的话，模型手写 【WM_PASS】 时标签会漏进气泡（单测抓过）。 */
  function stripWmTags(raw) {
    return String(raw || '').replace(/[\[【]{1,2}\s*WM_[A-Z]+\s*(?:[:：][^\]】]*)?[\]】]{1,2}/gi, '').trim();
  }

  /**
   * 解析 TA 回复里的 WM 标签（宽容匹配：[[..]] / 【..】 / 全角冒号 / 空格都认）。
   * 只做**解析 + 剥净**，不动牌 —— 动牌与落库由 page-chat 拿着 chatId 走 mutate
   * （这里是纯函数，拿不到会话）。
   * 返回 { text, pass, partial:{words}, reject, play:{chars} }
   */
  function parseWmTags(raw) {
    var s = String(raw || '');
    var partialM = s.match(/[\[【]{1,2}\s*WM_PARTIAL\s*[:：]\s*([^\]】]*)[\]】]{1,2}/i);
    var hasPass = /[\[【]{1,2}\s*WM_PASS\s*[\]】]{1,2}/i.test(s);
    var hasReject = /[\[【]{1,2}\s*WM_REJECT\s*[\]】]{1,2}/i.test(s);
    var playM = s.match(/[\[【]{1,2}\s*WM_PLAY\s*[:：]\s*([^\]】]*)[\]】]{1,2}/i);
    var play = null;
    if (playM) {
      var chars = playM[1].split(/[|｜、,，\s]+/).map(function (t) { return t.trim(); }).filter(Boolean);
      if (chars.length) play = { chars: chars };
    }
    var partial = null;
    if (partialM) {
      var words = partialM[1].split(/[|｜]/).map(function (w) { return w.trim(); }).filter(function (w) { return w.length >= 2; });
      if (words.length) partial = { words: words };
    }
    return {
      text: stripWmTags(s),
      pass: hasPass,
      partial: partial,
      reject: hasReject,
      play: play
    };
  }

})(typeof window !== 'undefined' ? window : globalThis);
