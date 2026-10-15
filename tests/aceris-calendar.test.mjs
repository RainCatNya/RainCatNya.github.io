/* ==================== 星历日历内核的回归测试 ====================
   历法算错一天, 整页全是错的, 所以先把内核钉死。

   跑法: node --test tests/  （或 npm test）
   ⚠️ aceris-calendar.js 是给浏览器用的老式脚本（没有 export），所以这里用 node:vm 灌进沙箱。
   ============================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const sandbox = vm.createContext({ console });
vm.runInContext(read('../public/script/aceris-calendar.js'), sandbox);
const run = (expr) => vm.runInContext(expr, sandbox);
/* ⚠️ vm 沙箱里造出来的对象与 Node 主 context **不是同一个 realm**, deepStrictEqual 会报
   「Values have same structure but are not reference-equal」——所以断言前一律摊平成普通对象。 */
const plain = (expr) => ({ ...run(expr) });

const dateOf = (y, m, d) => ({ ...run(`acerisFromGregorian(${y}, ${m}, ${d})`) });

test('锚点：公历 2025-11-23 = 一历正月初七（原稿给的那一句）', () => {
  const date = dateOf(2025, 11, 23);
  assert.equal(date.year, 1);
  assert.equal(date.month, 1);
  assert.equal(date.day, 7);
  assert.equal(run(`acerisDateText(${JSON.stringify(date)})`), '一历 · 正月初七');
});

test('纪元当天：公历 2025-11-17 = 一历正月初一', () => {
  const date = dateOf(2025, 11, 17);
  assert.deepEqual([date.year, date.month, date.day], [1, 1, 1]);
  assert.equal(date.delta, 0);
});

test('今天：公历 2026-09-17 = 一历弦月初五', () => {
  const date = dateOf(2026, 9, 17);
  assert.deepEqual([date.year, date.month, date.day], [1, 11, 5]);
  assert.equal(date.delta, 304);
  assert.equal(run(`acerisDateText(${JSON.stringify(date)})`), '一历 · 弦月初五');
});

test('没有闰日：一历 360 天整，二历正月初一 = 公历 2026-11-12', () => {
  assert.deepEqual(dateOf(2026, 11, 11), { year: 1, month: 12, day: 30, delta: 359 });
  assert.deepEqual(dateOf(2026, 11, 12), { year: 2, month: 1, day: 1, delta: 360 });
});

test('一历的每个月初一都对得上（月长 30 天）', () => {
  const starts = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  starts.forEach((delta, index) => {
    const date = run(`acerisFromDelta(${delta})`);
    assert.equal(date.year, 1);
    assert.equal(date.month, index + 1);
    assert.equal(date.day, 1);
  });
});

test('来回换算自洽：正着算再倒着算回到原地', () => {
  for (let delta = 0; delta < 1080; delta += 7) {
    const date = run(`acerisFromDelta(${delta})`);
    const back = run(`acerisToDelta(${date.year}, ${date.month}, ${date.day})`);
    assert.equal(back, delta);
    const g = run(`acerisGregorianFromDelta(${delta})`);
    const again = run(`acerisDeltaFromGregorian(${g.y}, ${g.m}, ${g.d})`);
    assert.equal(again, delta);
  }
});

test('月名与日名：原文里出现过的那几个', () => {
  assert.equal(run('acerisMonthName(1)'), '正月');
  assert.equal(run('acerisMonthName(2)'), '偏月');
  assert.equal(run('acerisMonthName(11)'), '弦月');
  assert.equal(run('acerisMonthName(12)'), '空月');
  assert.equal(run('acerisDayName(1)'), '初一');
  assert.equal(run('acerisDayName(10)'), '初十');
  assert.equal(run('acerisDayName(11)'), '十一');
  assert.equal(run('acerisDayName(20)'), '二十');
  assert.equal(run('acerisDayName(23)'), '廿三');
  assert.equal(run('acerisDayName(30)'), '三十');
});

test('年份写法：一历 / 二历 / 十一历 / 一百零五历', () => {
  assert.equal(run('acerisNumberText(1)'), '一');
  assert.equal(run('acerisNumberText(2)'), '二');
  assert.equal(run('acerisNumberText(10)'), '十');
  assert.equal(run('acerisNumberText(11)'), '十一');
  assert.equal(run('acerisNumberText(30)'), '三十');
  assert.equal(run('acerisNumberText(105)'), '一百零五');
});

test('节日：正月初一诞元节、皓月廿三星风节（= 公历 2026-07-07）', () => {
  assert.equal(run('acerisFestivalOf(1, 1).name'), '诞元节');
  assert.equal(run('acerisFestivalOf(8, 23).name'), '星风节');
  assert.equal(run('acerisFestivalOf(3, 3)'), null);
  assert.deepEqual(dateOf(2026, 7, 7), { year: 1, month: 8, day: 23, delta: 232 });
});

test('一个月的 30 格：日序、公历、节日都带上', () => {
  const days = run('acerisMonthDays(1, 8)');
  assert.equal(days.length, 30);
  assert.equal(days[0].dayName, '初一');
  assert.equal(days[29].dayName, '三十');
  assert.equal(days[22].festival.name, '星风节');
  assert.equal(days[22].gregorianText, '2026-07-07');
  assert.equal(days[0].gregorianText, '2026-06-15');
  // 每格都能直接拼成完整日期（界面的 aria-label 就是这么用的）
  assert.equal(run(`acerisDateText(${JSON.stringify(days[0])})`), '一历 · 皓月初一');
  assert.equal(run('acerisNumberText(undefined)'), '');
});

test('翻月：跨年、往回翻', () => {
  assert.deepEqual(plain('acerisShiftMonth(1, 12, 1)'), { year: 2, month: 1 });
  assert.deepEqual(plain('acerisShiftMonth(1, 1, -1)'), { year: 0, month: 12 });
  assert.deepEqual(plain('acerisShiftMonth(1, 6, 6)'), { year: 1, month: 12 });
  assert.deepEqual(plain('acerisShiftMonth(1, 6, 7)'), { year: 2, month: 1 });
});

test('今天按 UTC+8 切日：UTC 的 2026-09-17 16:30 已经是 18 号了', () => {
  const beforeEdge = new Date('2026-09-17T15:59:00Z');
  const afterEdge = new Date('2026-09-17T16:01:00Z');
  assert.deepEqual(plain(`acerisToday(new Date('${beforeEdge.toISOString()}'))`), { y: 2026, m: 9, d: 17 });
  assert.deepEqual(plain(`acerisToday(new Date('${afterEdge.toISOString()}'))`), { y: 2026, m: 9, d: 18 });
});
