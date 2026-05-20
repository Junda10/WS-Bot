// Runtime config. All sensitive / per-deployment values come from .env.
// See .env.example for the required keys.

module.exports = {
  myNumber: process.env.MY_NUMBER || '',
  groupId: process.env.GROUP_ID || '',

  // Auto-reply "ok" to anyone who messages you
  autoReply: {
    enabled: (process.env.AUTO_REPLY_ENABLED || 'true') === 'true',
    message: process.env.AUTO_REPLY_MESSAGE || 'ok',
  },

  // Daily news schedule (24h format)
  scheduleHour: parseInt(process.env.SCHEDULE_HOUR || '8', 10),
  scheduleMinute: parseInt(process.env.SCHEDULE_MINUTE || '0', 10),

  // Comma-separated WhatsApp user IDs allowed to call !website
  websiteWhitelist: (process.env.WEBSITE_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean),

  // Clarification (ask-user / slot-filling) module
  // When enabled, ambiguous user questions trigger structured option-based clarification
  // instead of going straight to smartReply.
  clarification: {
    enabled: process.env.CLARIFY_ENABLED === 'true',
    ambiguityThreshold: parseFloat(process.env.CLARIFY_THRESHOLD || '0.1'),
    maxRounds: parseInt(process.env.CLARIFY_MAX_ROUNDS || '20', 10),
    softWarnRound: parseInt(process.env.CLARIFY_SOFT_WARN || '10', 10),
    sessionTtlMs: parseInt(process.env.CLARIFY_TTL_MS || String(30 * 60 * 1000), 10),
    whitelist: (process.env.CLARIFY_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean),
    classifyModel: process.env.CLARIFY_MODEL || null,
  },
};
