'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDedicatedLegacyCommand } = require('../commands/legacy-command-recognition');
const {
  formatWorkout,
  todayMessage,
  weekMessage,
  weekdayInTz,
  WORKOUTS,
  WEEK,
} = require('../workout');

const KEYS = ['A', 'B', 'C'];
const SECTION_HEADINGS = [
  '*🔥 一、10 分钟热身*',
  '*🏋️ 二、主训练*',
  '*🧱 三、核心循环（2 轮）*',
  '*🏃 四、跑步机收尾*',
  '*📌 五、训练原则*',
  '*🥗 六、训练后营养与补水*',
  '*⭐ 七、今日强度*',
];

function assertHeadingsInOrder(text) {
  let previousIndex = -1;
  for (const heading of SECTION_HEADINGS) {
    const index = text.indexOf(heading);
    assert.ok(index > previousIndex, `${heading} should exist in the shared section order`);
    previousIndex = index;
  }
}

test('A/B/C use the same complete detailed Chinese guide hierarchy', () => {
  for (const key of KEYS) {
    const text = formatWorkout(key);

    assert.match(text, new RegExp(`\\*Day ${KEYS.indexOf(key) + 1}｜${key} 天`));
    assert.match(text, /🎯 \*目标：\*/);
    assert.match(text, /⏱️ \*总时长：\* 约 65-75 分钟/);
    assertHeadingsInOrder(text);
    assert.match(text, /10 分钟热身/);
    assert.match(text, /核心循环（2 轮）/);
    assert.match(text, /坡度走：跑步机/);
    assert.match(text, /可选 HIIT/);
    assert.match(text, /训练后 1-2 小时/);
    assert.match(text, /500-750ml/);
    assert.match(text, /动作难度：[★☆]{5}/);
    assert.match(text, /心肺强度：[★☆]{5}/);
    assert.match(text, /疲劳目标：6\/10/);
  }
});

test('every main exercise has explicit per-set kg x reps and rest details', () => {
  for (const key of KEYS) {
    const text = formatWorkout(key);
    const setLines = text.match(/第 [123] 组：\d+(?:\.\d+)?kg × (?:各 )?\d+ 次/g) || [];
    const restLines = text.match(/⏸️ 组间休息：/g) || [];

    assert.equal(WORKOUTS[key].exercises.length, 5);
    assert.equal(setLines.length, 15, `${key} should list three weighted sets for five exercises`);
    assert.equal(restLines.length, 5, `${key} should include rest after every exercise`);
  }
});

test('guides have distinct complementary focuses and conservative return guidance', () => {
  assert.equal(new Set(KEYS.map((key) => WORKOUTS[key].focus)).size, 3);
  assert.equal(new Set(KEYS.map((key) => WORKOUTS[key].exercises[0].name)).size, 3);

  for (const key of KEYS) {
    const text = formatWorkout(key);
    assert.match(text, /重量只是回归起点/);
    assert.match(text, /降重 10-20%/);
    assert.match(text, /保留 2-3 次余力/);
    assert.match(text, /不追求力竭、不强迫完成失败动作/);
    assert.match(text, /疼痛就停止相关动作/);
    assert.match(text, /头晕.*停止训练/);
    assert.match(text, /考虑寻求合资格专业人士意见/);
    assert.ok(text.length < 4096, `${key} guide must remain safely below the WhatsApp text limit`);
  }
});

test('today message deterministically maps Saturday/Monday/Wednesday to A/B/C', () => {
  const cases = [
    ['2026-07-25T12:00:00.000Z', 6, 'A', '周六', 'Day 1｜A 天'],
    ['2026-07-27T12:00:00.000Z', 1, 'B', '周一', 'Day 2｜B 天'],
    ['2026-07-29T12:00:00.000Z', 3, 'C', '周三', 'Day 3｜C 天'],
  ];

  for (const [iso, weekday, key, dayName, guideTitle] of cases) {
    const now = new Date(iso);
    assert.equal(weekdayInTz('UTC', now), weekday);
    assert.equal(WEEK[weekday], key);
    const text = todayMessage('UTC', now);
    assert.match(text, new RegExp(`今日健身\\* · ${dayName}`));
    assert.ok(text.includes(guideTitle));
    assertHeadingsInOrder(text);
  }
});

test('today message stays concise on rest days and identifies the next training', () => {
  const cases = [
    ['2026-07-26T12:00:00.000Z', '周日', '周一（B 天）'],
    ['2026-07-28T12:00:00.000Z', '周二', '周三（C 天）'],
    ['2026-07-30T12:00:00.000Z', '周四', '周六（A 天）'],
    ['2026-07-31T12:00:00.000Z', '周五', '周六（A 天）'],
  ];

  for (const [iso, dayName, nextTraining] of cases) {
    const text = todayMessage('UTC', new Date(iso));
    assert.match(text, new RegExp(`今日健身\\* · ${dayName}`));
    assert.match(text, /今天是休息日/);
    assert.ok(text.includes(`下次训练：${nextTraining}`));
    assert.doesNotMatch(text, /一、10 分钟热身/);
    assert.ok(text.length < 300);
  }
});

test('injected instant respects timezone and weekly overview remains concise and accurate', () => {
  const instant = new Date('2026-07-25T16:30:00.000Z');
  assert.equal(weekdayInTz('UTC', instant), 6);
  assert.equal(weekdayInTz('Asia/Kuala_Lumpur', instant), 0);
  const localMessage = todayMessage('Asia/Kuala_Lumpur', instant);
  assert.match(localMessage, /周日/);
  assert.match(localMessage, /今天是休息日/);

  const overview = weekMessage();
  assert.match(overview, /周一.*B 天/);
  assert.match(overview, /周三.*C 天/);
  assert.match(overview, /周六.*A 天/);
  assert.equal((overview.match(/休息日/g) || []).length, 4);
  assert.ok(overview.length < 1000);
});

test('existing fitness command aliases still recognize default, week, and A/B/C forms', () => {
  for (const alias of ['!健身', '!fitness', '!workout', '!gym']) {
    assert.equal(isDedicatedLegacyCommand(alias), true);
    assert.equal(isDedicatedLegacyCommand(`${alias} week`), true);
    for (const key of KEYS) assert.equal(isDedicatedLegacyCommand(`${alias} ${key}`), true);
  }
});
