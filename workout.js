'use strict';

// 为 170cm / 55kg、停练约一个月后回归的新手提供一周 3 次全身训练。
// A/B/C 只保存结构化计划；命令和定时提醒统一通过 formatWorkout 输出详细文案。

const WORKOUTS = {
  A: {
    day: 'Day 1',
    title: 'A 天 · 回归全身训练（下肢 + 推）',
    focus: '重新熟悉深蹲、水平推和拉，保守找回动作节奏',
    duration: '约 65-75 分钟',
    warmup: [
      '3 分钟跑步机轻松走（坡度 0-2%，能正常说话）',
      '2 分钟肩绕环、髋绕环与踝关节活动',
      '2 分钟徒手深蹲 2 × 8 次 + 臀桥 1 × 10 次',
      '3 分钟用主动作约一半重量做 2 组递增热身，不计入正式组',
    ],
    exercises: [
      {
        name: '杠铃深蹲（总重）',
        cue: '脚掌踩稳，下降到可控制深度；先动作稳定再加重。',
        sets: [['20kg', 10], ['22.5kg', 8], ['22.5kg', 8]],
        rest: '90-120 秒',
      },
      {
        name: '平板哑铃卧推（每手）',
        cue: '肩胛轻收，手腕保持中立，不弹震借力。',
        sets: [['5kg', 12], ['6kg', 10], ['6kg', 10]],
        rest: '75-90 秒',
      },
      {
        name: '高位下拉',
        cue: '先下沉肩胛，再把握把拉向上胸。',
        sets: [['20kg', 12], ['22.5kg', 10], ['22.5kg', 10]],
        rest: '75-90 秒',
      },
      {
        name: '哑铃罗马尼亚硬拉（每手）',
        cue: '髋部向后推，背部保持自然，感受腿后侧拉伸。',
        sets: [['6kg', 12], ['8kg', 10], ['8kg', 10]],
        rest: '90 秒',
      },
      {
        name: '坐姿哑铃肩推（每手）',
        cue: '背部贴稳靠垫，避免耸肩或过度后仰。',
        sets: [['4kg', 12], ['5kg', 10], ['5kg', 10]],
        rest: '60-75 秒',
      },
    ],
    core: [
      '死虫式 8 次/侧',
      '侧平板支撑 20 秒/侧',
      '鸟狗式 8 次/侧',
    ],
    cardio: {
      steady: '跑步机 8-10 分钟：坡度 4-6%，速度 4.5-5.5km/h，以能短句交谈为准。',
      hiit: '可选 HIIT（回归稳定 2 周且当天状态良好才做）：4 轮 20 秒轻快跑 + 70 秒慢走；与坡走二选一。',
    },
    ratings: {
      technique: '★★★☆☆',
      strength: '★★★☆☆',
      cardio: '★★☆☆☆',
      fatigue: '6/10（结束时应感觉还能完成 2-3 次标准动作）',
    },
  },
  B: {
    day: 'Day 2',
    title: 'B 天 · 回归全身训练（髋主导 + 拉）',
    focus: '练习安全髋铰链，强化背部与单腿稳定',
    duration: '约 65-75 分钟',
    warmup: [
      '3 分钟划船机或跑步机轻松走（低阻力）',
      '2 分钟猫牛式、胸椎旋转与肩胛活动',
      '2 分钟徒手早安式 2 × 8 次 + 反向箭步蹲 1 × 6 次/侧',
      '3 分钟用主动作约一半重量做 2 组递增热身，不计入正式组',
    ],
    exercises: [
      {
        name: '壶铃硬拉（总重）',
        cue: '壶铃靠近身体，髋部后移；站起时不向后过伸。',
        sets: [['12kg', 10], ['16kg', 8], ['16kg', 8]],
        rest: '90-120 秒',
      },
      {
        name: '上斜哑铃卧推（每手）',
        cue: '凳面约 30°，肩胛贴稳，控制下放。',
        sets: [['4kg', 12], ['5kg', 10], ['5kg', 10]],
        rest: '75-90 秒',
      },
      {
        name: '坐姿绳索划船',
        cue: '躯干稳定，肘部向后带，不用腰部摆动。',
        sets: [['17.5kg', 12], ['20kg', 10], ['20kg', 10]],
        rest: '75-90 秒',
      },
      {
        name: '反向哑铃箭步蹲（每手）',
        cue: '步幅以膝髋舒适为准，可扶固定物保持平衡。',
        sets: [['3kg', 10], ['4kg', 8], ['4kg', 8]],
        rest: '75-90 秒',
      },
      {
        name: '哑铃侧平举（每手）',
        cue: '手肘微屈，抬到肩高以内，不耸肩。',
        sets: [['2kg', 12], ['2kg', 12], ['2kg', 12]],
        rest: '60 秒',
      },
    ],
    core: [
      'Pallof 抗旋转推 10 次/侧',
      '平板支撑点肩 8 次/侧',
      '仰卧交替触踝 12 次/侧',
    ],
    cardio: {
      steady: '跑步机 8-10 分钟：坡度 3-5%，速度 4.5-5.5km/h，以呼吸可控为准。',
      hiit: '可选 HIIT（回归稳定 2 周且当天状态良好才做）：5 轮 20 秒轻快跑 + 70 秒慢走；与坡走二选一。',
    },
    ratings: {
      technique: '★★★☆☆',
      strength: '★★★☆☆',
      cardio: '★★☆☆☆',
      fatigue: '6/10（结束时应感觉还能完成 2-3 次标准动作）',
    },
  },
  C: {
    day: 'Day 3',
    title: 'C 天 · 回归全身训练（腿推 + 肩臂）',
    focus: '用器械稳定完成腿推与上肢推拉，补充肩臂训练',
    duration: '约 65-75 分钟',
    warmup: [
      '3 分钟椭圆机或跑步机轻松走（低阻力）',
      '2 分钟弹力带拉开、肩绕环与髋关节活动',
      '2 分钟箱式徒手深蹲 2 × 8 次 + 墙面俯卧撑 1 × 8 次',
      '3 分钟用主动作约一半重量做 2 组递增热身，不计入正式组',
    ],
    exercises: [
      {
        name: '腿举机（配重片总重）',
        cue: '腰背贴垫，膝盖跟随脚尖方向，不锁死膝关节。',
        sets: [['25kg', 12], ['30kg', 10], ['30kg', 10]],
        rest: '90 秒',
      },
      {
        name: '坐姿哑铃肩推（每手）',
        cue: '核心收紧，背部贴垫，在舒适活动范围内推起。',
        sets: [['4kg', 12], ['5kg', 10], ['5kg', 10]],
        rest: '75-90 秒',
      },
      {
        name: '胸托哑铃划船（每手）',
        cue: '胸部贴稳斜凳，肘部向髋部方向拉。',
        sets: [['5kg', 12], ['6kg', 10], ['6kg', 10]],
        rest: '75-90 秒',
      },
      {
        name: '臀推（总重）',
        cue: '下巴微收，顶端夹臀，不用腰部过伸。',
        sets: [['15kg', 12], ['20kg', 10], ['20kg', 10]],
        rest: '90 秒',
      },
      {
        name: '绳索弯举 + 三头下压（各自配重）',
        cue: '两动作连续完成算一组，肘部位置保持稳定。',
        sets: [['5kg', '各 12'], ['7.5kg', '各 10'], ['7.5kg', '各 10']],
        rest: '完成两个动作后 60-75 秒',
      },
    ],
    core: [
      '反向卷腹 10 次',
      '前臂平板支撑 25 秒',
      '单手提重行走 6kg × 20 米/侧',
    ],
    cardio: {
      steady: '跑步机 8-10 分钟：坡度 4-6%，速度 4.5-5.5km/h，以步态稳定为准。',
      hiit: '可选 HIIT（回归稳定 2 周且当天状态良好才做）：4 轮 30 秒轻快跑 + 60 秒慢走；与坡走二选一。',
    },
    ratings: {
      technique: '★★☆☆☆',
      strength: '★★★☆☆',
      cardio: '★★☆☆☆',
      fatigue: '6/10（结束时应感觉还能完成 2-3 次标准动作）',
    },
  },
};

// 0=周日 ... 6=周六；训练日从周六 A 开始，周一 B、周三 C。
const WEEK = {
  0: null,
  1: 'B',
  2: null,
  3: 'C',
  4: null,
  5: null,
  6: 'A',
};

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const REST_TIPS = [
  '💤 可轻松散步 20-30 分钟或做温和活动，让身体恢复。',
  '🍚 休息日也保持规律三餐，每餐可搭配主食和蛋白质来源。',
  '😴 尽量睡足 7-8 小时，并留意第二天的恢复感受。',
  '💧 按口渴程度和天气补水，不需要用高强度运动补课。',
];

const TRAINING_PRINCIPLES = [
  '以上重量只是回归起点：若动作变形或做不到目标次数，降重 10-20%；若全程轻松且标准，下次只小幅加重。',
  '每组保留 2-3 次余力，不追求力竭、不强迫完成失败动作。',
  '出现尖锐/持续疼痛就停止相关动作；头晕、恶心、胸闷或明显不适时停止训练并休息，持续或严重时考虑寻求合资格专业人士意见。',
];

const RECOVERY_GUIDANCE = [
  '训练后 1-2 小时内可安排一餐：约 20-30g 蛋白质 + 一份碳水，例如鸡蛋/牛奶/豆制品配饭或面。',
  '训练期间按口渴小口喝水；训练后可先补约 500-750ml，再依天气、出汗量和个人情况调整。',
];

function formatSets(sets) {
  return sets.map(([weight, reps], index) => `   第 ${index + 1} 组：${weight} × ${reps} 次`).join('\n');
}

function formatWorkout(key) {
  const normalizedKey = String(key || '').toUpperCase();
  const workout = WORKOUTS[normalizedKey];
  if (!workout) throw new RangeError(`Unknown workout: ${key}`);

  const warmup = workout.warmup.map((item, index) => `${index + 1}. ${item}`).join('\n');
  const exercises = workout.exercises.map((exercise, index) => (
    `*${index + 1}. ${exercise.name}*\n${formatSets(exercise.sets)}\n   动作提示：${exercise.cue}\n   ⏸️ 组间休息：${exercise.rest}`
  )).join('\n\n');
  const core = workout.core.map((item) => `• ${item}`).join('\n');
  const principles = TRAINING_PRINCIPLES.map((item) => `• ${item}`).join('\n');
  const recovery = RECOVERY_GUIDANCE.map((item) => `• ${item}`).join('\n');

  return [
    `🏋️ *${workout.day}｜${workout.title}*`,
    `🎯 *目标：* ${workout.focus}`,
    `⏱️ *总时长：* ${workout.duration}`,
    '━━━━━━━━━━━━━━━━━━',
    '*🔥 一、10 分钟热身*',
    warmup,
    '*🏋️ 二、主训练*',
    exercises,
    '*🧱 三、核心循环（2 轮）*',
    core,
    '动作间休息 15-20 秒，每轮休息 45-60 秒；全程保持呼吸。',
    '*🏃 四、跑步机收尾*',
    `• 坡度走：${workout.cardio.steady}`,
    `• ${workout.cardio.hiit}`,
    '*📌 五、训练原则*',
    principles,
    '*🥗 六、训练后营养与补水*',
    recovery,
    '*⭐ 七、今日强度*',
    `• 动作难度：${workout.ratings.technique}`,
    `• 力量强度：${workout.ratings.strength}`,
    `• 心肺强度：${workout.ratings.cardio}`,
    `• 疲劳目标：${workout.ratings.fatigue}`,
  ].join('\n\n');
}

function weekdayInTz(tz, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  const opts = tz ? { timeZone: tz, weekday: 'short' } : { weekday: 'short' };
  const shortDay = new Intl.DateTimeFormat('en-US', opts).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[shortDay] ?? date.getDay();
}

function tipIndexForDate(tz, date, length) {
  const opts = tz
    ? { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date);
  const total = parts
    .filter(({ type }) => ['year', 'month', 'day'].includes(type))
    .reduce((sum, { value }) => sum + Number(value), 0);
  return total % length;
}

function todayMessage(tz, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const dow = weekdayInTz(tz, date);
  const key = WEEK[dow];
  const header = `🏋️ *今日健身* · ${DAY_NAMES[dow]}`;

  if (key) return `${header}\n━━━━━━━━━━━━━━━━━━\n\n${formatWorkout(key)}`;

  const tip = REST_TIPS[tipIndexForDate(tz, date, REST_TIPS.length)];
  return `${header}\n━━━━━━━━━━━━━━━━━━\n\n😌 *今天是休息日*，以恢复为主。\n\n${tip}\n\n下次训练：${nextTrainingLabel(dow)}`;
}

function nextTrainingLabel(dow) {
  for (let offset = 1; offset <= 7; offset += 1) {
    const nextDay = (dow + offset) % 7;
    if (WEEK[nextDay]) return `${DAY_NAMES[nextDay]}（${WEEK[nextDay]} 天）`;
  }
  return '';
}

function weekMessage() {
  let output = '🗓️ *每周增肌计划*（170cm / 55kg · 一周 3 练）\n━━━━━━━━━━━━━━━━━━\n\n';
  for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
    const key = WEEK[dow];
    output += key
      ? `*${DAY_NAMES[dow]}* — ${WORKOUTS[key].title}\n`
      : `*${DAY_NAMES[dow]}* — 😴 休息日\n`;
  }
  output += '\n💡 每周 3 次全身训练，主要动作错开，训练日之间安排恢复。';
  output += '\n🍚 保持规律饮食、足够蛋白质与 7-8 小时睡眠，并按恢复情况调整。';
  output += '\n\n发送 *!健身* 看今天安排，*!健身 A/B/C* 看详细训练，*!健身 周* 看本页。';
  return output;
}

module.exports = {
  todayMessage,
  weekMessage,
  formatWorkout,
  weekdayInTz,
  WORKOUTS,
  WEEK,
};
