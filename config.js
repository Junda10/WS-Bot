'use strict';

const path = require('path');

// Runtime config. All sensitive / per-deployment values come from .env.
// See .env.example for the required keys.

const USER_JID_DOMAINS = new Set(['c.us', 'lid']);
const VISION_POLICIES = new Set(['off', 'ocr-only', 'ocr-first', 'vision-first']);

class ConfigValidationError extends Error {
  constructor(errors) {
    super(`Invalid configuration:\n- ${errors.join('\n- ')}`);
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

function readInteger(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(String(raw).trim())) return Number.NaN;
  return Number(raw);
}

function readNumber(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function readBoolean(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function normalizeJid(value, { kind = 'user' } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  const jid = /^\d+$/.test(raw) && kind === 'user' ? `${raw}@c.us` : raw;
  const match = /^([a-z0-9._:-]+)@([a-z0-9.]+)$/.exec(jid);
  if (!match) return '';

  const domain = match[2];
  if (kind === 'group' && domain !== 'g.us') return '';
  if (kind === 'user' && !USER_JID_DOMAINS.has(domain)) return '';
  return `${match[1]}@${domain}`;
}

function normalizeJidList(value, options) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((jid) => normalizeJid(jid, options)).filter(Boolean))];
}

function loadConfig(env = process.env) {
  const root = process.cwd();
  const maxFileMb = readInteger(env, 'PM_MAX_FILE_MB', 20);
  const timezone = String(env.PM_TIMEZONE || 'Asia/Kuala_Lumpur').trim();

  return {
    myNumber: env.MY_NUMBER || '',
    groupId: env.GROUP_ID || '',

    // Legacy "ok" auto-reply. Off by default now — the AI smart-reply + clarification
    // path handles messages instead. Set AUTO_REPLY_ENABLED=true to restore the old "ok".
    autoReply: {
      enabled: readBoolean(env, 'AUTO_REPLY_ENABLED', false),
      message: env.AUTO_REPLY_MESSAGE || 'ok',
    },

    // Existing news, fitness and FX schedules remain independent from PM reports.
    scheduleHour: readInteger(env, 'SCHEDULE_HOUR', 8),
    scheduleMinute: readInteger(env, 'SCHEDULE_MINUTE', 0),
    scheduleTz: env.SCHEDULE_TZ || 'Asia/Kuala_Lumpur',

    fitness: {
      enabled: readBoolean(env, 'FITNESS_ENABLED', true),
      hour: readInteger(env, 'FITNESS_HOUR', 12),
      minute: readInteger(env, 'FITNESS_MINUTE', 0),
      target: env.FITNESS_TARGET || '',
    },

    fx: {
      enabled: readBoolean(env, 'FX_ENABLED', true),
      hour: readInteger(env, 'FX_HOUR', 20),
      minute: readInteger(env, 'FX_MINUTE', 0),
      target: env.FX_TARGET || '',
      ai: readBoolean(env, 'FX_AI', true),
    },

    websiteWhitelist: normalizeJidList(env.WEBSITE_WHITELIST),

    smartReply: {
      debounceMs: readInteger(env, 'SMART_REPLY_DEBOUNCE_MS', 3000),
      replyDelayBaseMs: readInteger(env, 'REPLY_DELAY_BASE_MS', 1000),
      replyDelayPerCharMs: readInteger(env, 'REPLY_DELAY_PER_CHAR_MS', 80),
      replyDelayMinMs: readInteger(env, 'REPLY_DELAY_MIN_MS', 2000),
      replyDelayMaxMs: readInteger(env, 'REPLY_DELAY_MAX_MS', 5000),
    },

    clarification: {
      enabled: readBoolean(env, 'CLARIFY_ENABLED', false),
      ambiguityThreshold: readNumber(env, 'CLARIFY_THRESHOLD', 0.1),
      maxRounds: readInteger(env, 'CLARIFY_MAX_ROUNDS', 20),
      softWarnRound: readInteger(env, 'CLARIFY_SOFT_WARN', 10),
      sessionTtlMs: readInteger(env, 'CLARIFY_TTL_MS', 30 * 60 * 1000),
      whitelist: normalizeJidList(env.CLARIFY_WHITELIST),
      classifyModel: env.CLARIFY_MODEL || null,
    },

    pm: {
      authorizedGroupJid: normalizeJid(env.PM_AUTHORIZED_GROUP_JID, { kind: 'group' }),
      ericJid: normalizeJid(env.PM_ERIC_JID),
      adminJids: normalizeJidList(env.PM_ADMIN_JIDS),
    },

    database: {
      path: path.resolve(root, env.DB_PATH || 'data/wsb.sqlite3'),
      busyTimeoutMs: readInteger(env, 'DB_BUSY_TIMEOUT_MS', 5000),
    },

    storage: {
      attachmentsDir: path.resolve(root, env.PM_ATTACHMENTS_DIR || 'data/attachments'),
      tempDir: path.resolve(root, env.PM_TEMP_DIR || 'data/tmp'),
      maxFileMb,
      maxFileBytes: Number.isFinite(maxFileMb) ? maxFileMb * 1024 * 1024 : Number.NaN,
    },

    retention: {
      messageDays: readInteger(env, 'PM_MESSAGE_RETENTION_DAYS', 30),
    },

    reports: {
      timezone,
      recoveryWindowHours: readInteger(env, 'PM_REPORT_RECOVERY_HOURS', 24),
    },

    media: {
      ocrEnabled: readBoolean(env, 'PM_OCR_ENABLED', true),
      ocrLanguages: String(env.PM_OCR_LANGUAGES || 'eng+chi_sim').trim(),
      visionPolicy: String(env.PM_VISION_POLICY || 'ocr-first').trim().toLowerCase(),
    },

    backup: {
      directory: path.resolve(root, env.PM_BACKUP_DIR || 'data/backups'),
      retentionCount: readInteger(env, 'PM_BACKUP_RETENTION_COUNT', 14),
      remoteUrl: String(env.PM_BACKUP_REMOTE_URL || '').trim(),
    },
  };
}

function validateConfig(config, { requirePm = true } = {}) {
  const errors = [];
  const integerInRange = (value, min, max, name) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${name} must be an integer from ${min} to ${max}`);
    }
  };
  const validBoolean = (value, name) => {
    if (typeof value !== 'boolean') errors.push(`${name} must be "true" or "false"`);
  };
  const validTimezone = (value, name) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    } catch {
      errors.push(`${name} must be a valid IANA timezone`);
    }
  };

  if (requirePm) {
    if (!config.pm.authorizedGroupJid) {
      errors.push('PM_AUTHORIZED_GROUP_JID is required and must end in @g.us');
    }
    if (!config.pm.ericJid) {
      errors.push('PM_ERIC_JID is required and must be a user JID (digits, @c.us, or @lid)');
    }
    if (config.pm.adminJids.length === 0) {
      errors.push('PM_ADMIN_JIDS must contain at least one valid user JID');
    }
  }

  integerInRange(config.scheduleHour, 0, 23, 'SCHEDULE_HOUR');
  integerInRange(config.scheduleMinute, 0, 59, 'SCHEDULE_MINUTE');
  validTimezone(config.scheduleTz, 'SCHEDULE_TZ');
  validBoolean(config.autoReply.enabled, 'AUTO_REPLY_ENABLED');

  validBoolean(config.fitness.enabled, 'FITNESS_ENABLED');
  integerInRange(config.fitness.hour, 0, 23, 'FITNESS_HOUR');
  integerInRange(config.fitness.minute, 0, 59, 'FITNESS_MINUTE');
  validBoolean(config.fx.enabled, 'FX_ENABLED');
  validBoolean(config.fx.ai, 'FX_AI');
  integerInRange(config.fx.hour, 0, 23, 'FX_HOUR');
  integerInRange(config.fx.minute, 0, 59, 'FX_MINUTE');

  integerInRange(config.smartReply.debounceMs, 0, 10 * 60 * 1000, 'SMART_REPLY_DEBOUNCE_MS');
  integerInRange(config.smartReply.replyDelayBaseMs, 0, 60 * 1000, 'REPLY_DELAY_BASE_MS');
  integerInRange(config.smartReply.replyDelayPerCharMs, 0, 10 * 1000, 'REPLY_DELAY_PER_CHAR_MS');
  integerInRange(config.smartReply.replyDelayMinMs, 0, 60 * 1000, 'REPLY_DELAY_MIN_MS');
  integerInRange(config.smartReply.replyDelayMaxMs, 0, 60 * 1000, 'REPLY_DELAY_MAX_MS');
  if (config.smartReply.replyDelayMinMs > config.smartReply.replyDelayMaxMs) {
    errors.push('REPLY_DELAY_MIN_MS must not exceed REPLY_DELAY_MAX_MS');
  }

  validBoolean(config.clarification.enabled, 'CLARIFY_ENABLED');
  if (!Number.isFinite(config.clarification.ambiguityThreshold)
      || config.clarification.ambiguityThreshold < 0
      || config.clarification.ambiguityThreshold > 1) {
    errors.push('CLARIFY_THRESHOLD must be a number from 0 to 1');
  }
  integerInRange(config.clarification.maxRounds, 1, 100, 'CLARIFY_MAX_ROUNDS');
  integerInRange(config.clarification.softWarnRound, 1, 100, 'CLARIFY_SOFT_WARN');
  integerInRange(config.clarification.sessionTtlMs, 1000, 7 * 24 * 60 * 60 * 1000, 'CLARIFY_TTL_MS');

  if (!config.database.path) errors.push('DB_PATH must not be empty');
  integerInRange(config.database.busyTimeoutMs, 0, 120000, 'DB_BUSY_TIMEOUT_MS');
  integerInRange(config.storage.maxFileMb, 1, 100, 'PM_MAX_FILE_MB');
  integerInRange(config.retention.messageDays, 1, 3650, 'PM_MESSAGE_RETENTION_DAYS');
  validTimezone(config.reports.timezone, 'PM_TIMEZONE');
  integerInRange(config.reports.recoveryWindowHours, 1, 168, 'PM_REPORT_RECOVERY_HOURS');
  validBoolean(config.media.ocrEnabled, 'PM_OCR_ENABLED');
  if (!config.media.ocrLanguages) errors.push('PM_OCR_LANGUAGES must not be empty');
  if (!VISION_POLICIES.has(config.media.visionPolicy)) {
    errors.push(`PM_VISION_POLICY must be one of: ${[...VISION_POLICIES].join(', ')}`);
  }
  integerInRange(config.backup.retentionCount, 1, 365, 'PM_BACKUP_RETENTION_COUNT');

  if (errors.length) throw new ConfigValidationError(errors);
  return config;
}

const config = loadConfig(process.env);
Object.defineProperties(config, {
  loadConfig: { value: loadConfig },
  validateConfig: { value: validateConfig },
  assertValid: { value: (options) => validateConfig(config, options) },
  normalizeJid: { value: normalizeJid },
  normalizeJidList: { value: normalizeJidList },
  ConfigValidationError: { value: ConfigValidationError },
});

module.exports = config;
