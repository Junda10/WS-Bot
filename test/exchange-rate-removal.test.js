'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDedicatedLegacyCommand } = require('../commands/legacy-command-recognition');
const { loadConfig } = require('../config');
const { registerLegacySchedules } = require('../services/legacy-schedule-registrar');

function fakeCron() {
  const registrations = [];
  return {
    registrations,
    schedule(expression, callback, options) {
      const task = { expression, callback, options, stop() {} };
      registrations.push(task);
      return task;
    },
  };
}

test('legacy registration schedules only news and fitness even when retired env values remain', async () => {
  const cron = fakeCron();
  const logs = [];
  let newsRuns = 0;
  let fitnessRuns = 0;
  const config = loadConfig({
    SCHEDULE_HOUR: '8',
    SCHEDULE_MINUTE: '5',
    SCHEDULE_TZ: 'Asia/Kuala_Lumpur',
    FITNESS_ENABLED: 'true',
    FITNESS_HOUR: '12',
    FITNESS_MINUTE: '10',
    FX_ENABLED: 'true',
    FX_HOUR: '20',
    FX_MINUTE: '15',
    FX_TARGET: 'network-target@g.us',
    FX_AI: 'true',
  });

  const tasks = registerLegacySchedules({
    cron,
    config,
    sendMorningNews: async () => { newsRuns += 1; },
    sendFitnessReminder: async () => { fitnessRuns += 1; },
    logger: { log: (line) => logs.push(line) },
  });

  assert.equal(Object.hasOwn(config, 'fx'), false, 'retired environment values must be ignored');
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    cron.registrations.map(({ expression, options }) => ({ expression, options })),
    [
      { expression: '5 8 * * *', options: { timezone: 'Asia/Kuala_Lumpur' } },
      { expression: '10 12 * * *', options: { timezone: 'Asia/Kuala_Lumpur' } },
    ]
  );
  assert.equal(cron.registrations.some(({ expression }) => expression === '15 20 * * *'), false);
  assert.equal(logs.length, 2, 'only news and fitness registration messages are logged');

  await Promise.all(cron.registrations.map(({ callback }) => callback()));
  assert.equal(newsRuns, 1);
  assert.equal(fitnessRuns, 1);
});

test('retired rate commands are not dedicated commands and cannot reach a network handler', async () => {
  const retiredCommands = ['!汇率', '!汇率 ai', '!fx', '!fx ai', '!rate'];
  let networkCalls = 0;

  for (const command of retiredCommands) {
    if (isDedicatedLegacyCommand(command)) {
      networkCalls += 1;
      throw new Error(`network path unexpectedly reached for ${command}`);
    }
  }

  assert.equal(networkCalls, 0);
  assert.equal(isDedicatedLegacyCommand('!news'), true);
  assert.equal(isDedicatedLegacyCommand('!fitness week'), true);
  assert.equal(isDedicatedLegacyCommand('!help'), true);
});
