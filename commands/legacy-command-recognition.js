'use strict';

const EXACT_COMMANDS = new Set([
  '!news',
  '!tech',
  '!world',
  '!car',
  '!property',
  '!rank',
  '!raw',
  '!mymemory',
  '!forget',
  '!nosession',
  '!groups',
  '!help',
  '!websites',
  '!健身',
  '!fitness',
  '!workout',
  '!gym',
  '!ar',
]);

const PREFIX_COMMANDS = [
  '!website ',
  '!delsite ',
  '!ask ',
  '!translate ',
  '!tr ',
  '!weather ',
  '!天气 ',
  '!健身 ',
  '!fitness ',
  '!workout ',
  '!gym ',
  '!remind ',
  '!broadcast ',
  '!ar ',
];

function isDedicatedLegacyCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  return EXACT_COMMANDS.has(normalized)
    || normalized === '!website'
    || PREFIX_COMMANDS.some((prefix) => normalized.startsWith(prefix));
}

module.exports = { isDedicatedLegacyCommand };
