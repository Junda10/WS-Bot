#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });

// This is intentionally excluded from npm test. Requiring both a flag and an
// environment opt-in prevents accidental billable/network calls.
if (!process.argv.includes('--run') || process.env.OPENROUTER_PM_SMOKE !== '1') {
  console.error('Refusing network call. Use OPENROUTER_PM_SMOKE=1 and --run explicitly.');
  process.exitCode = 2;
  return;
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required (the key will not be printed).');
  process.exitCode = 2;
  return;
}

const { createStructuredAi } = require('../ai');
const model = process.env.OPENROUTER_PM_SMOKE_MODEL || 'z-ai/glm-4.7-flash';
const structured = createStructuredAi({ models: [model] });

function redacted(label, result) {
  const output = {
    call: label,
    ok: result.ok,
    model: result.model,
    attempts: result.attempts,
    errorCode: result.error?.code || null,
  };
  if (result.ok) {
    output.valueFields = Object.keys(result.value || {}).sort();
    output.arrayCounts = Object.fromEntries(
      Object.entries(result.value || {})
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, value.length])
    );
  }
  console.log(JSON.stringify(output));
}

(async () => {
  // At most three requests: one cheap model and one attempt for each tiny contract.
  const results = [
    ['extractIssue', await structured.extractIssue('Merchant M1 reports login error E1.')],
    ['matchReply', await structured.matchReply('E1 fixed; retry login.', [{
      publicId: 'TV1',
      title: 'M1 login error E1',
      description: 'Merchant M1 reports login error E1.',
      status: 'WAITING_TEVAU',
      createdAt: 1,
    }])],
    ['summarizeConversation', await structured.summarizeConversation([
      'A: M1 has login error E1. B: I will ask Tevau.',
    ])],
  ];
  for (const [label, result] of results) redacted(label, result);
  if (results.some(([, result]) => !result.ok)) process.exitCode = 1;
})().catch(() => {
  // Keep provider/request internals and all prompt data out of smoke output.
  console.error('OpenRouter PM smoke failed safely.');
  process.exitCode = 1;
});
