// workout.js — 健身教练模块（增肌）
// 为 170cm / 55kg 偏瘦增肌人群设计的一周3天全身训练计划（含休息日）。
// 训练日：周一 / 周三 / 周五，其余为休息日。理念：大重量复合动作 + 渐进超负荷 + 热量盈余。
//
// 每日提醒由 index.js 的 cron 触发，命令 !健身 / !fitness 也复用这里的计划数据。
// 计划内容与文案集中在此，方便日后调整；不含任何隐私信息（本仓库为公开仓库）。

// 周一/周三/周五三套全身训练（A/B/C 轮换），每块肌群一周刺激 ~3 次，最适合新手增肌。
const WORKOUTS = {
  A: {
    title: 'A 天 · 下肢主导 + 推',
    focus: '深蹲 + 卧推为主',
    warmup: '热身 5-10 分钟：动感单车/快走 + 空杆活动关节',
    exercises: [
      '杠铃深蹲 (Squat)      3 组 × 5-8 次',
      '杠铃平板卧推 (Bench)  3 组 × 5-8 次',
      '杠铃划船 (Barbell Row) 3 组 × 8-10 次',
      '哑铃肩推 (DB Press)    3 组 × 10-12 次',
      '平板支撑 (Plank)       3 组 × 30-45 秒',
    ],
  },
  B: {
    title: 'B 天 · 硬拉主导 + 拉',
    focus: '硬拉 + 背部为主',
    warmup: '热身 5-10 分钟：划船机 + 臀桥 + 轻重量硬拉热身',
    exercises: [
      '杠铃硬拉 (Deadlift)      3 组 × 5 次',
      '高位下拉/引体 (Lat Pull) 3 组 × 8-10 次',
      '上斜哑铃卧推 (Incline)   3 组 × 8-10 次',
      '哑铃弯举 (DB Curl)       3 组 × 10-12 次',
      '悬垂举腿 (Leg Raise)     3 组 × 12 次',
    ],
  },
  C: {
    title: 'C 天 · 综合 + 肩臂',
    focus: '肩推 + 手臂强化',
    warmup: '热身 5-10 分钟：椭圆机 + 肩部弹力带激活',
    exercises: [
      '腿举/高杯深蹲 (Leg Press) 3 组 × 8-10 次',
      '站姿杠铃肩推 (OHP)        3 组 × 6-8 次',
      '坐姿绳索划船 (Cable Row)  3 组 × 10-12 次',
      '哑铃侧平举 (Lateral)      3 组 × 12-15 次',
      '三头下压 + 二头弯举       各 3 组 × 12 次',
    ],
  },
};

// 星期几 -> 训练内容。0=周日 ... 6=周六。null 表示休息日。
// 训练日：周六 / 周一 / 周三（从开练当天周六起算），其余休息。
const WEEK = {
  6: 'A', // 周六
  0: null, // 周日 休息
  1: 'B', // 周一
  2: null, // 周二 休息
  3: 'C', // 周三
  4: null, // 周四 休息
  5: null, // 周五 休息
};

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 休息日轮流显示的恢复/饮食提醒（增肌关键：吃够 + 睡够）。
const REST_TIPS = [
  '💤 主动恢复：轻松散步 20-30 分钟或拉伸，别让肌肉僵硬。',
  '🍚 今天不练也要吃够！增肌 = 热量盈余，每餐都要有主食 + 蛋白。',
  '😴 睡足 7-8 小时，肌肉是在休息时长出来的，不是在健身房。',
  '🥛 蛋白别断：目标每天 ~90-120g（约 1.6-2.2g/kg 体重）。',
];

// 通用增肌小贴士（附在训练日文案后）。
const COACH_TIPS = [
  '💪 渐进超负荷：这周能做到目标次数上限，下次就加 2.5kg。',
  '🍗 练后 1 小时内补充蛋白 + 碳水，帮助恢复。',
  '📈 55kg 偏瘦增肌，关键是热量盈余：每天比消耗多吃 ~300-500 大卡。',
  '📝 记录每次的重量和次数，看到进步才有动力。',
  '💧 训练时多喝水，动作做标准比加重量更重要。',
];

// 取指定时区的当前星期几（0-6）。默认跟随服务器时区。
function weekdayInTz(tz) {
  const opts = tz ? { timeZone: tz, weekday: 'short' } : { weekday: 'short' };
  const s = new Intl.DateTimeFormat('en-US', opts).format(new Date());
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[s] ?? new Date().getDay();
}

// 用日期做“随机但当天固定”的索引，让贴士每天轮换而非真随机。
function tipIndexForToday(tz, len) {
  const s = new Intl.DateTimeFormat('en-US', tz ? { timeZone: tz, day: 'numeric', month: 'numeric' } : { day: 'numeric', month: 'numeric' }).format(new Date());
  const n = s.split('/').reduce((a, b) => a + parseInt(b, 10), 0);
  return n % len;
}

function formatWorkout(key) {
  const w = WORKOUTS[key];
  const lines = w.exercises.map((e, i) => `${i + 1}. ${e}`).join('\n');
  return `*${w.title}*\n🔥 重点：${w.focus}\n\n${w.warmup}\n\n${lines}\n\n组间休息 90-120 秒。`;
}

// 生成“今日”提醒文案（训练日 or 休息日）。
function todayMessage(tz) {
  const dow = weekdayInTz(tz);
  const key = WEEK[dow];
  const header = `🏋️ *今日健身* · ${DAY_NAMES[dow]}`;
  if (!key) {
    const tip = REST_TIPS[tipIndexForToday(tz, REST_TIPS.length)];
    return `${header}\n━━━━━━━━━━━━━━━━━━\n\n😌 *今天是休息日*，好好恢复！\n\n${tip}\n\n下次训练：${nextTrainingLabel(dow)}`;
  }
  const tip = COACH_TIPS[tipIndexForToday(tz, COACH_TIPS.length)];
  return `${header}\n━━━━━━━━━━━━━━━━━━\n\n${formatWorkout(key)}\n\n${tip}`;
}

// 找下一个训练日的标签（例：周三）。
function nextTrainingLabel(dow) {
  for (let i = 1; i <= 7; i++) {
    const d = (dow + i) % 7;
    if (WEEK[d]) return DAY_NAMES[d];
  }
  return '';
}

// 整周计划总览。
function weekMessage() {
  let out = '🗓️ *每周增肌计划* (170cm / 55kg · 一周3练)\n━━━━━━━━━━━━━━━━━━\n\n';
  for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
    const key = WEEK[dow];
    if (key) {
      out += `*${DAY_NAMES[dow]}* — ${WORKOUTS[key].title}\n`;
    } else {
      out += `*${DAY_NAMES[dow]}* — 😴 休息日\n`;
    }
  }
  out += '\n💡 每块肌群一周练 3 次，训练日之间隔天恢复。';
  out += '\n🍚 增肌铁律：热量盈余 + 每天 ~90-120g 蛋白 + 睡足 7-8h。';
  out += '\n\n发送 *!健身* 看今天练什么，*!健身 A/B/C* 看某天详情。';
  return out;
}

module.exports = {
  todayMessage,
  weekMessage,
  formatWorkout,
  WORKOUTS,
  WEEK,
};
