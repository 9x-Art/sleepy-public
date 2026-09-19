/* ============================================================
   calendar-data.js — 日历的内置离线数据包

   ---- 为什么是 .js 不是 .json ----
   项目的第一条硬约束是「双击 index.html 就能开」（file://）。
   file:// 下 fetch() 一个本地 json 会被 CORS 直接拦死，
   所以离线数据必须像别的模块一样挂到 window 上。
   路径也不进子目录：本项目是扁平的（只有 vendor/ 例外）。

   ---- 数据从哪来（不许编）----
   中国大陆：国务院办公厅《关于XXXX年部分节假日安排的通知》。
     · 2025 = 国办发明电〔2024〕12 号
     · 2026 = 国务院办公厅 2025 年 11 月发布
   两份都是多个官方来源（中国政府网 / 央视新闻 / 光明网）互证过的。
   **2027 及以后尚未公布，绝不猜** —— 参见总纲 §19.1：
   超出内置年份就如实说「该年度未内置法定节假日数据」，不伪造调休。

   日/韩/美/英：用**规则**算（固定日期 + 第 N 个月曜），规则本身就是
   内置数据，所以不设年份上限。只有英国那几个跟着复活节走的假，
   用标准的匿名格里高利算法现算（算法确定性，不联网）。
   ⚠️ 第一版**不做各国补休/振替休日**（日本「振替休日」、韩国代替公休日、
   英国 Christmas 撞周末顺延）—— 总纲 §18.7 明确第一版不做这些细分。
   这一点在区域说明里对 user 如实写出来，不让数据假装完整。

   ---- 农历 ----
   本项目**没有可靠的农历库**（page-desktop.js 里那个 lunarText 是近似的
   假货，不能用来算节日）。所以农历派生的节日（除夕/春节/元宵/端午/
   七夕/中秋/重阳）走「**内置年份显式日期表**」，只列能核实的那两年。
   超出的年份不显示农历节日，而不是硬算一个错的日期出去
   （总纲 §10.5：「日期不明确时不得硬猜」）。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});

  /* ------------------------- 中国大陆 · 法定放假安排 -------------------------

     每个假期块：
       name      假期名（官方写法，如「国庆节、中秋节」）
       from/to   放假区间（含首尾）
       workdays  需要上班的周末（**周末补班日**，总纲 §5.3 要求单独识别）

     kind 在 calendar.js 里派生，这里只存事实。 */
  var CN_OFFICIAL = {
    2025: {
      source: 'CN-2025-v1',
      note: '国办发明电〔2024〕12 号',
      holidays: [
        { name: '元旦', from: '2025-01-01', to: '2025-01-01', workdays: [] },
        { name: '春节', from: '2025-01-28', to: '2025-02-04', workdays: ['2025-01-26', '2025-02-08'] },
        { name: '清明节', from: '2025-04-04', to: '2025-04-06', workdays: [] },
        { name: '劳动节', from: '2025-05-01', to: '2025-05-05', workdays: ['2025-04-27'] },
        { name: '端午节', from: '2025-05-31', to: '2025-06-02', workdays: [] },
        { name: '国庆节、中秋节', from: '2025-10-01', to: '2025-10-08', workdays: ['2025-09-28', '2025-10-11'] }
      ]
    },
    2026: {
      source: 'CN-2026-v1',
      note: '国务院办公厅关于 2026 年部分节假日安排的通知',
      holidays: [
        { name: '元旦', from: '2026-01-01', to: '2026-01-03', workdays: ['2026-01-04'] },
        { name: '春节', from: '2026-02-15', to: '2026-02-23', workdays: ['2026-02-14', '2026-02-28'] },
        { name: '清明节', from: '2026-04-04', to: '2026-04-06', workdays: [] },
        { name: '劳动节', from: '2026-05-01', to: '2026-05-05', workdays: ['2026-05-09'] },
        { name: '端午节', from: '2026-06-19', to: '2026-06-21', workdays: [] },
        { name: '中秋节', from: '2026-09-25', to: '2026-09-27', workdays: [] },
        { name: '国庆节', from: '2026-10-01', to: '2026-10-07', workdays: ['2026-09-20', '2026-10-10'] }
      ]
    }
  };

  /* ------------------------- 中国大陆 · 文化节日 -------------------------
     农历派生的节日逐条显式列出（见文件头「农历」那条的说明）。
     春节那条**同时是法定假期**，calendar.js 会让法定层优先，
     文化层只补一个「节日」标记，不重复出两条事件。 */
  var CN_FESTIVALS = {
    2025: [
      { date: '2025-01-07', name: '腊八节' },
      { date: '2025-01-28', name: '除夕' },
      { date: '2025-01-29', name: '春节' },
      { date: '2025-02-12', name: '元宵节' },
      { date: '2025-04-04', name: '清明节' },
      { date: '2025-05-31', name: '端午节' },
      { date: '2025-08-29', name: '七夕' },
      { date: '2025-10-06', name: '中秋节' },
      { date: '2025-10-29', name: '重阳节' }
    ],
    2026: [
      { date: '2026-01-26', name: '腊八节' },
      { date: '2026-02-16', name: '除夕' },
      { date: '2026-02-17', name: '春节' },
      { date: '2026-03-03', name: '元宵节' },
      { date: '2026-04-05', name: '清明节' },
      { date: '2026-06-19', name: '端午节' },
      { date: '2026-08-19', name: '七夕' },
      { date: '2026-09-25', name: '中秋节' },
      { date: '2026-10-18', name: '重阳节' }
    ]
  };

  /* 不放假的纪念日（固定公历）。只作为日历上一个极轻的标记，
     绝不画成「休」—— 总纲 §5.3 那条红线：不能靠猜把工作日判成休息。 */
  var CN_COMMEMORATION = [
    { date: '03-08', name: '妇女节', note: '妇女放假半天' },
    { date: '05-04', name: '青年节', note: '14 周岁以上青年放假半天' },
    { date: '06-01', name: '儿童节', note: '不满 14 周岁少年儿童放假 1 天' },
    { date: '08-01', name: '建军节', note: '现役军人放假半天' },
    { date: '09-10', name: '教师节' }
  ];

  /* ------------------------- 国际常见节日（固定公历，可跨区显示） -------- */
  var INTL_FESTIVALS = [
    { date: '02-14', name: '情人节' },
    { date: '10-31', name: '万圣节' },
    { date: '11-11', name: '双十一' },
    { date: '12-24', name: '平安夜' },
    { date: '12-25', name: '圣诞节' },
    { date: '12-31', name: '跨年夜' },
    { date: '01-01', name: '新年' }
  ];

  /* ---------------------------- 第 N 个月曜 ----------------------------
     nth: 第几个（1 起）；nth = -1 表示「最后一个」。
     day: 0=周日 … 6=周六 */
  function nthWeekday(y, m, day, nth) {
    var d;
    if (nth > 0) {
      d = new Date(y, m - 1, 1);
      var shift = (day - d.getDay() + 7) % 7;
      d = new Date(y, m - 1, 1 + shift + (nth - 1) * 7);
      return d.getMonth() === m - 1 ? pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) : null;
    }
    /* 最后一个：从下个月 0 号（本月最后一天）往回找 */
    d = new Date(y, m, 0);
    var back = (d.getDay() - day + 7) % 7;
    d = new Date(y, m - 1, d.getDate() - back);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* 复活节（匿名格里高利算法，确定性、不联网）。
     英国那两个跟着它走的银行假日要用。 */
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100;
    var d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var hh = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - hh - k) % 7;
    var m = Math.floor((a + 11 * hh + 22 * l) / 451);
    var mo = Math.floor((hh + l - 7 * m + 114) / 31);
    var da = ((hh + l - 7 * m + 114) % 31) + 1;
    return new Date(y, mo - 1, da);
  }

  function shift(base, days) {
    var d = new Date(base.getTime() + days * 86400000);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ---------------------------- 规则型区域 ----------------------------
     产出同上：{ date:'MM-DD', name }。calendar.js 会补上 region 与年份。
     别在这里做补休顺延（见文件头）。 */
  var REGION_RULES = {
    JP: {
      label: '日本',
      note: '祝日按固定日期与「第 N 个月曜」算；振替休日（撞周日的补休）第一版不做。',
      holidays: function (y) {
        return [
          { date: '01-01', name: '元日' },
          { date: nthWeekday(y, 1, 1, 2), name: '成人の日' },
          { date: '02-11', name: '建国記念の日' },
          { date: '02-23', name: '天皇誕生日' },
          { date: '03-20', name: '春分の日（约）' },
          { date: '04-29', name: '昭和の日' },
          { date: '05-03', name: '憲法記念日' },
          { date: '05-04', name: 'みどりの日' },
          { date: '05-05', name: 'こどもの日' },
          { date: nthWeekday(y, 7, 1, 3), name: '海の日' },
          { date: '08-11', name: '山の日' },
          { date: nthWeekday(y, 9, 1, 3), name: '敬老の日' },
          { date: '09-23', name: '秋分の日（约）' },
          { date: nthWeekday(y, 10, 1, 2), name: 'スポーツの日' },
          { date: '11-03', name: '文化の日' },
          { date: '11-23', name: '勤労感謝の日' }
        ];
      }
    },
    KR: {
      label: '韩国',
      note: '只含固定公历的公休日；설날 / 추석 是农历节日，未内置农历库，暂不显示。',
      holidays: function () {
        return [
          { date: '01-01', name: '신정（新正）' },
          { date: '03-01', name: '삼일절（三一节）' },
          { date: '05-05', name: '어린이날（儿童节）' },
          { date: '06-06', name: '현충일（显忠日）' },
          { date: '08-15', name: '광복절（光复节）' },
          { date: '10-03', name: '개천절（开天节）' },
          { date: '10-09', name: '한글날（韩文节）' },
          { date: '12-25', name: '기독탄신일（圣诞）' }
        ];
      }
    },
    US: {
      label: '美国',
      note: '联邦法定假日；不含州级假日，撞周末的顺延第一版不做。',
      holidays: function (y) {
        return [
          { date: '01-01', name: 'New Year' },
          { date: nthWeekday(y, 1, 1, 3), name: 'MLK Day' },
          { date: nthWeekday(y, 2, 1, 3), name: 'Presidents Day' },
          { date: nthWeekday(y, 5, 1, -1), name: 'Memorial Day' },
          { date: '06-19', name: 'Juneteenth' },
          { date: '07-04', name: 'Independence Day' },
          { date: nthWeekday(y, 9, 1, 1), name: 'Labor Day' },
          { date: nthWeekday(y, 10, 1, 2), name: 'Columbus Day' },
          { date: '11-11', name: 'Veterans Day' },
          { date: nthWeekday(y, 11, 4, 4), name: 'Thanksgiving' },
          { date: '12-25', name: 'Christmas' }
        ];
      }
    },
    UK: {
      label: '英国',
      note: '英格兰与威尔士的 bank holiday；苏格兰/北爱另有假日，第一版不细分。撞周末的顺延不做。',
      holidays: function (y) {
        var e = easter(y);
        return [
          { date: '01-01', name: "New Year's Day" },
          { date: shift(e, -2), name: 'Good Friday' },
          { date: shift(e, 1), name: 'Easter Monday' },
          { date: nthWeekday(y, 5, 1, 1), name: 'Early May' },
          { date: nthWeekday(y, 5, 1, -1), name: 'Spring Bank Holiday' },
          { date: nthWeekday(y, 8, 1, -1), name: 'Summer Bank Holiday' },
          { date: '12-25', name: 'Christmas Day' },
          { date: '12-26', name: 'Boxing Day' }
        ];
      }
    }
  };

  /* 区域元数据。`builtinYears` 为 null = 规则可覆盖任意年份。 */
  var REGIONS = [
    {
      id: 'CN',
      label: '中国大陆',
      timezone: 'Asia/Shanghai',
      builtinYears: Object.keys(CN_OFFICIAL).map(Number),
      note: '含官方法定假期、调休休息日与周末补班。2027 及以后尚未公布，不猜。'
    },
    { id: 'JP', label: '日本', timezone: 'Asia/Tokyo', builtinYears: null, note: REGION_RULES.JP.note },
    { id: 'KR', label: '韩国', timezone: 'Asia/Seoul', builtinYears: null, note: REGION_RULES.KR.note },
    { id: 'US', label: '美国', timezone: 'America/New_York', builtinYears: null, note: REGION_RULES.US.note },
    { id: 'UK', label: '英国', timezone: 'Europe/London', builtinYears: null, note: REGION_RULES.UK.note },
    { id: 'NONE', label: '不注入', timezone: '', builtinYears: [], note: '只看公历与星期，不叠任何公共假期。' }
  ];

  /* 文化节日分组 —— 设置页的多选就是按这四组列（总纲 §4.2）。 */
  var CULTURE_GROUPS = [
    {
      id: 'cn',
      label: '中国传统节日',
      /* 农历派生的那批只能靠 CN_FESTIVALS 的显式表；固定公历的纪念日直接算。 */
      builtinYears: Object.keys(CN_FESTIVALS).map(Number),
      items: function (y) {
        var out = (CN_FESTIVALS[y] || []).map(function (f) {
          return { date: f.date, name: f.name };
        });
        CN_COMMEMORATION.forEach(function (c) {
          out.push({ date: y + '-' + c.date, name: c.name, soft: true });
        });
        return out;
      }
    },
    {
      id: 'intl',
      label: '国际常见节日',
      builtinYears: null,
      items: function (y) {
        return INTL_FESTIVALS.map(function (f) {
          return { date: y + '-' + f.date, name: f.name };
        });
      }
    },
    { id: 'jp', label: '日本节日文化', builtinYears: null, items: function (y) { return REGION_RULES.JP.holidays(y); } },
    { id: 'kr', label: '韩国传统节日', builtinYears: null, items: function (y) { return REGION_RULES.KR.holidays(y); } }
  ];

  /* 地区 → 他说哪国话。
     2026-09-19 定：**语言从常驻地点推**，不另开设置项（同「不要再开第四个设置项」那条）。
     zh 是「不用翻译」的那一支 —— 他跟 user 说同一种语言。 */
  var LANGS = {
    zh: { code: 'zh', name: '中文', native: '中文', same: true },
    ja: { code: 'ja', name: '日语', native: '日本語' },
    ko: { code: 'ko', name: '韩语', native: '한국어' },
    en: { code: 'en', name: '英语', native: 'English' }
  };
  var REGION_LANG = {
    CN: 'zh', JP: 'ja', KR: 'ko', US: 'en', UK: 'en', NONE: 'zh'
  };

  var TIMEZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
    'America/New_York', 'Europe/London', 'Europe/Paris', 'Australia/Sydney'];

  /* 时区 → 一个能读的地名（char 没填城市时拿来当「常驻地点」的说法）。
     只用于显示，不参与任何计算。 */
  var TZ_LABELS = {
    'Asia/Shanghai': '上海',
    'Asia/Tokyo': '东京',
    'Asia/Seoul': '首尔',
    'America/New_York': '纽约',
    'Europe/London': '伦敦',
    'Europe/Paris': '巴黎',
    'Australia/Sydney': '悉尼'
  };

  /* 没有 Intl（或它不支持某个时区名）时的兜底偏移，单位分钟。
     ⚠️ 这是**近似值，不含夏令时** —— 走到这条路时注入的文本会带一个「约」字，
     绝不假装精确。正常浏览器都走 Intl 那条路。 */
  var TZ_OFFSET_MIN = {
    'Asia/Shanghai': 480,
    'Asia/Tokyo': 540,
    'Asia/Seoul': 540,
    'America/New_York': -300,
    'Europe/London': 0,
    'Europe/Paris': 60,
    'Australia/Sydney': 600
  };

  Sleepy.calendarData = {
    CN_OFFICIAL: CN_OFFICIAL,
    CN_FESTIVALS: CN_FESTIVALS,
    CN_COMMEMORATION: CN_COMMEMORATION,
    INTL_FESTIVALS: INTL_FESTIVALS,
    REGION_RULES: REGION_RULES,
    REGIONS: REGIONS,
    CULTURE_GROUPS: CULTURE_GROUPS,
    TIMEZONES: TIMEZONES,
    LANGS: LANGS,
    REGION_LANG: REGION_LANG,
    TZ_LABELS: TZ_LABELS,
    TZ_OFFSET_MIN: TZ_OFFSET_MIN,
    nthWeekday: nthWeekday,
    easter: easter,
    /* 冒烟用：把这个包里的年份摊平，方便断言「不许出现 2027」这类规矩 */
    builtinYears: function () {
      var out = {};
      for (var r in CN_OFFICIAL) if (CN_OFFICIAL.hasOwnProperty(r)) out[r] = 'CN';
      return Object.keys(out).map(Number).sort();
    }
  };

})(window);
