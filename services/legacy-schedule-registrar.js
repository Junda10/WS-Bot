'use strict';

function registerLegacySchedules({
  cron,
  config,
  sendMorningNews,
  sendFitnessReminder,
  logger = console,
}) {
  const tasks = [];
  const min = String(config.scheduleMinute);
  const hr = String(config.scheduleHour);

  tasks.push(cron.schedule(
    `${min} ${hr} * * *`,
    () => sendMorningNews(),
    { timezone: config.scheduleTz }
  ));
  logger.log(`⏰ 每天 ${config.scheduleHour}:${String(config.scheduleMinute).padStart(2, '0')} (${config.scheduleTz}) 自动发送AI新闻摘要`);

  if (config.fitness?.enabled) {
    const fitnessMinute = String(config.fitness.minute);
    const fitnessHour = String(config.fitness.hour);
    tasks.push(cron.schedule(
      `${fitnessMinute} ${fitnessHour} * * *`,
      () => sendFitnessReminder(),
      { timezone: config.scheduleTz }
    ));
    logger.log(`🏋️ 每天 ${config.fitness.hour}:${String(config.fitness.minute).padStart(2, '0')} (${config.scheduleTz}) 自动发送健身提醒`);
  }

  return tasks;
}

module.exports = { registerLegacySchedules };
