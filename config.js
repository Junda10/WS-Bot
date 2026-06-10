// Runtime config. All sensitive / per-deployment values come from .env.
// See .env.example for the required keys.

module.exports = {
  myNumber: process.env.MY_NUMBER || '',
  groupId: process.env.GROUP_ID || '',

  // Legacy "ok" auto-reply. Off by default now — the AI smart-reply + clarification
  // path handles messages instead. Set AUTO_REPLY_ENABLED=true to restore the old "ok".
  autoReply: {
    enabled: (process.env.AUTO_REPLY_ENABLED || 'false') === 'true',
    message: process.env.AUTO_REPLY_MESSAGE || 'ok',
  },

  // Daily news schedule (24h format)
  scheduleHour: parseInt(process.env.SCHEDULE_HOUR || '8', 10),
  scheduleMinute: parseInt(process.env.SCHEDULE_MINUTE || '0', 10),

  // Comma-separated WhatsApp user IDs allowed to call !website
  websiteWhitelist: (process.env.WEBSITE_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean),

  // Smart-reply debounce: wait this many ms after a user's last message before processing.
  // Multiple messages within the window are merged (joined with newline) and answered once.
  // Applies only to the smart-reply / clarification path — ! commands still fire instantly.
  smartReply: {
    debounceMs: parseInt(process.env.SMART_REPLY_DEBOUNCE_MS || '3000', 10),
    // Anti-ban: never reply instantly. The reply is paced like a human typing —
    // delay = base "thinking" time + per-character typing time, scaled by reply
    // length, jittered, and clamped between min and max. Typical short replies
    // land ~2-3s, longer ones up to the cap.
    replyDelayBaseMs: parseInt(process.env.REPLY_DELAY_BASE_MS || '1000', 10),
    replyDelayPerCharMs: parseInt(process.env.REPLY_DELAY_PER_CHAR_MS || '80', 10),
    replyDelayMinMs: parseInt(process.env.REPLY_DELAY_MIN_MS || '2000', 10),
    replyDelayMaxMs: parseInt(process.env.REPLY_DELAY_MAX_MS || '5000', 10),
  },

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
