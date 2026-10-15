/* aceris-calendar.js 星历历法内核 */
/*
  内容: 纯函数 + 常量 (不碰 DOM、不发请求), 页面逻辑在 public/aceris/index.html
  依赖: 无 (tests/aceris-calendar.test.mjs 用 vm 灌进来跑)
*/
// 历法参数来自原稿: 一年 12 个月 × 30 天 = 360 天, 没有闰月也没有闰日 (多出来的时间不修正, 误差顺着漂);
// 纪元 = 一历正月初一 的公历 2025-11-17 (由「公历 2025-11-23 = 一历正月初七」倒推); 年份写「N 历」, 没有「周」这个概念
// 「正月初一」在公历上逐年往前漂 (一年比回归年少约 5.24 天) 是历法本身的设定, 不是 bug, 别顺手给它加闰日

// 十二个月名
const ACERIS_MONTH_NAMES = [
  '正月', '偏月', '离月', '异月', '斜月', '渺月',
  '晓月', '皓月', '皎月', '逝月', '弦月', '空月'
];

/* 日名：初一…初十 / 十一…十九 / 二十 / 廿一…廿九 / 三十（共 30 个，正好一个月） */
const ACERIS_DAY_NAMES = (() => {
  const chinese = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const out = [];
  for (let day = 1; day <= 30; day += 1) {
    if (day <= 9) out.push('初' + chinese[day]);
    else if (day === 10) out.push('初十');
    else if (day < 20) out.push('十' + chinese[day - 10]);
    else if (day === 20) out.push('二十');
    else if (day < 30) out.push('廿' + chinese[day - 20]);
    else out.push('三十');
  }
  return out;
})();

const ACERIS_MONTHS_PER_YEAR = 12;
const ACERIS_DAYS_PER_MONTH = 30;
const ACERIS_DAYS_PER_YEAR = ACERIS_MONTHS_PER_YEAR * ACERIS_DAYS_PER_MONTH;

/* 一历正月初一 对应的公历日（改这一行就等于改纪元） */
const ACERIS_EPOCH = { y: 2025, m: 11, d: 17 };
/* 切日用的时区偏移 (分钟): 固定 UTC+8, 所以海外访客看到的「今天」也是同一个星历日 */
const ACERIS_TZ_MINUTES = 8 * 60;

/* 目前只有这两个节（原稿如此）；以后加节就往这里追 */
const ACERIS_FESTIVALS = [
  { month: 1, day: 1, name: '诞元节', note: '一元复始' },
  { month: 8, day: 23, name: '星风节', note: '皓月廿三，星风起' }
];

const ACERIS_YEAR_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/* 公历 (y, m, d) → 从 1970-01-01 起的日序号（用 UTC 算，避免本地时区把日期挪一天） */
function acerisUtcDayNumber(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

const ACERIS_EPOCH_DAY = acerisUtcDayNumber(ACERIS_EPOCH.y, ACERIS_EPOCH.m, ACERIS_EPOCH.d);

/* 公历日 → 距纪元的天数（纪元当天 = 0，之前是负数） */
function acerisDeltaFromGregorian(y, m, d) {
  return acerisUtcDayNumber(y, m, d) - ACERIS_EPOCH_DAY;
}

/* 距纪元的天数 → 星历日期。year 从 1 起（1 = 一历）。 */
function acerisFromDelta(delta) {
  const year = Math.floor(delta / ACERIS_DAYS_PER_YEAR) + 1;
  const rest = delta - (year - 1) * ACERIS_DAYS_PER_YEAR;
  const month = Math.floor(rest / ACERIS_DAYS_PER_MONTH) + 1;
  const day = (rest % ACERIS_DAYS_PER_MONTH) + 1;
  return { year, month, day, delta };
}

/* 星历日期 → 距纪元的天数（acerisFromDelta 的逆运算） */
function acerisToDelta(year, month, day) {
  return (year - 1) * ACERIS_DAYS_PER_YEAR + (month - 1) * ACERIS_DAYS_PER_MONTH + (day - 1);
}

// 公历日期 → 星历日期
function acerisFromGregorian(y, m, d) {
  return acerisFromDelta(acerisDeltaFromGregorian(y, m, d));
}

/* 距纪元的天数 → 公历日期（用 UTC 那一套取值，等于加减天数） */
function acerisGregorianFromDelta(delta) {
  const t = new Date((ACERIS_EPOCH_DAY + delta) * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/* 现在的「公历日期」——按 ACERIS_TZ_MINUTES 切日（不传参就用当前时间） */
function acerisToday(now) {
  const t = new Date((now ? now.getTime() : Date.now()) + ACERIS_TZ_MINUTES * 60000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/* 中文数字 (年份用, 够到几百历): 传进来不是有限数就返回空串 ——
   月格对象没带 year/month 时, aria-label 会拼出「undefined百历 · undefined 月初一」 */
function acerisNumberText(value) {
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return '';
  if (n < 0) return '负' + acerisNumberText(-n);
  if (n < 10) return ACERIS_YEAR_DIGITS[n];
  if (n < 20) return '十' + (n === 10 ? '' : ACERIS_YEAR_DIGITS[n - 10]);
  if (n < 100) return ACERIS_YEAR_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? ACERIS_YEAR_DIGITS[n % 10] : '');
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!rest) return ACERIS_YEAR_DIGITS[hundreds] + '百';
  return ACERIS_YEAR_DIGITS[hundreds] + '百' + (rest < 10 ? '零' : '') + acerisNumberText(rest);
}

// 月名 (越界就退成「N 月」)
function acerisMonthName(month) {
  return ACERIS_MONTH_NAMES[month - 1] || (month + ' 月');
}

// 日名 (越界就退成「N 日」)
function acerisDayName(day) {
  return ACERIS_DAY_NAMES[day - 1] || (String(day) + ' 日');
}

/* 「一历 · 弦月初五」 */
function acerisDateText(date) {
  return acerisNumberText(date.year) + '历 · ' + acerisMonthName(date.month) + acerisDayName(date.day);
}

/* 「公历 2026-09-17」（零补齐，方便和界面里的日期对齐） */
function acerisGregorianText(g) {
  const pad = (n) => String(n).padStart(2, '0');
  return g.y + '-' + pad(g.m) + '-' + pad(g.d);
}

// 这一天的节 (没有就 null)
function acerisFestivalOf(month, day) {
  return ACERIS_FESTIVALS.find((item) => item.month === month && item.day === day) || null;
}

/* 一个月的 30 格 (给网格用): { year, month, day, dayName, delta, festival, gregorian, gregorianText };
   每格自带 year/month, 界面上拿它直接 acerisDateText() 就是一个完整的星历日期 */
function acerisMonthDays(year, month) {
  const out = [];
  for (let day = 1; day <= ACERIS_DAYS_PER_MONTH; day += 1) {
    const delta = acerisToDelta(year, month, day);
    const gregorian = acerisGregorianFromDelta(delta);
    out.push({
      year,
      month,
      day,
      dayName: acerisDayName(day),
      delta,
      festival: acerisFestivalOf(month, day),
      gregorian,
      gregorianText: acerisGregorianText(gregorian)
    });
  }
  return out;
}

/* 相邻月（翻页用；一年 12 个月，跨年自己进位） */
function acerisShiftMonth(year, month, step) {
  const index = (year - 1) * ACERIS_MONTHS_PER_YEAR + (month - 1) + step;
  return {
    year: Math.floor(index / ACERIS_MONTHS_PER_YEAR) + 1,
    month: (index % ACERIS_MONTHS_PER_YEAR + ACERIS_MONTHS_PER_YEAR) % ACERIS_MONTHS_PER_YEAR + 1
  };
}
