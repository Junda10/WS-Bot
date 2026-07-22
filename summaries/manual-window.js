'use strict';

const { DateTime } = require('luxon');
const { requireTimezone } = require('./window');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_MAX_MANUAL_HOURS = 168;
const DEFAULT_MAX_SINCE_DAYS = 30;

class SummaryWindowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SummaryWindowError';
    this.code = code;
  }
}

function requireNow(now) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative safe UTC millisecond integer');
  }
  return now;
}

function requireBound(value, fallback, name, max) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  }
  return resolved;
}

function manualWindow(kind, timezone, startUtcMs, endUtcMs, input, source) {
  if (!Number.isSafeInteger(startUtcMs) || startUtcMs < 0
      || !Number.isSafeInteger(endUtcMs) || endUtcMs <= startUtcMs) {
    throw new SummaryWindowError('EMPTY_WINDOW', '所选时间窗为空；开始时间必须早于当前时间。');
  }
  return Object.freeze({
    kind: 'MANUAL',
    selector: kind,
    input,
    source,
    timezone,
    startUtcMs,
    endUtcMs,
    scheduledForUtcMs: null,
    previousDay: null,
  });
}

function currentScheduledSlotStart(now, timezone) {
  const zone = requireTimezone(timezone);
  const local = DateTime.fromMillis(requireNow(now), { zone });
  const date = local.startOf('day');
  const minuteOfDay = local.hour * 60 + local.minute + local.second / 60
    + local.millisecond / 60000;
  let start;
  // At an exact report boundary, use the slot that has just ended. This keeps
  // the fallback useful and non-empty while retaining exact half-open bounds.
  if (minuteOfDay <= 10 * 60) start = date.minus({ days: 1 }).set({ hour: 20 });
  else if (minuteOfDay <= 14 * 60) start = date.set({ hour: 10 });
  else if (minuteOfDay <= 20 * 60) start = date.set({ hour: 14 });
  else start = date.set({ hour: 20 });
  return start.toUTC().toMillis();
}

function strictSince(value, timezone) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(text)) {
    throw new SummaryWindowError(
      'INVALID_SINCE',
      'since 时间格式错误；请使用：!summary since YYYY-MM-DD HH:mm（例如 2026-07-20 09:00）。'
    );
  }
  const parsed = DateTime.fromFormat(text, 'yyyy-LL-dd HH:mm', {
    zone: timezone,
    locale: 'en',
    setZone: true,
  });
  if (!parsed.isValid || parsed.toFormat('yyyy-LL-dd HH:mm') !== text) {
    throw new SummaryWindowError('INVALID_SINCE', 'since 日期或时间无效，请检查年月日和 24 小时制时间。');
  }
  return parsed.toUTC().toMillis();
}

function parseManualSummaryWindow(tokens, options = {}) {
  if (!Array.isArray(tokens)) throw new TypeError('summary tokens must be an array');
  const now = requireNow(options.now ?? Date.now());
  const timezone = requireTimezone(options.timezone || 'Asia/Kuala_Lumpur');
  const maxHours = requireBound(
    options.maxHours,
    DEFAULT_MAX_MANUAL_HOURS,
    'maxHours',
    24 * 365
  );
  const maxSinceDays = requireBound(
    options.maxSinceDays,
    DEFAULT_MAX_SINCE_DAYS,
    'maxSinceDays',
    3650
  );
  const normalized = tokens.map((token) => String(token));

  if (normalized.length === 0) {
    let latest = null;
    if (options.summaryRepository) {
      if (typeof options.summaryRepository.latestSuccessfulAutomatic !== 'function') {
        throw new TypeError('summaryRepository.latestSuccessfulAutomatic is required');
      }
      latest = options.summaryRepository.latestSuccessfulAutomatic(options.chatId, now);
    }
    const start = latest?.window_end ?? currentScheduledSlotStart(now, timezone);
    return manualWindow(
      'default', timezone, start, now, '', latest ? 'LATEST_SUCCESSFUL_AUTO' : 'SCHEDULED_SLOT_FALLBACK'
    );
  }

  if (normalized.length === 1) {
    const argument = normalized[0].trim();
    const lower = argument.toLowerCase();
    const hours = /^(\d+)h$/u.exec(lower);
    if (hours) {
      const value = Number(hours[1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > maxHours) {
        throw new SummaryWindowError(
          'HOURS_OUT_OF_RANGE',
          `小时范围无效；请使用 1h 至 ${maxHours}h。`
        );
      }
      return manualWindow('hours', timezone, now - value * HOUR_MS, now, argument, 'EXPLICIT');
    }
    const localNow = DateTime.fromMillis(now, { zone: timezone });
    if (lower === 'today') {
      return manualWindow(
        'today', timezone, localNow.startOf('day').toUTC().toMillis(), now, argument, 'EXPLICIT'
      );
    }
    if (lower === 'yesterday') {
      const end = localNow.startOf('day');
      return manualWindow(
        'yesterday', timezone, end.minus({ days: 1 }).toUTC().toMillis(),
        end.toUTC().toMillis(), argument, 'EXPLICIT'
      );
    }
  }

  const isSince = normalized[0]?.trim().toLowerCase() === 'since';
  if (isSince && (normalized.length === 2 || normalized.length === 3)) {
    const text = normalized.slice(1).join(' ').trim();
    const start = strictSince(text, timezone);
    if (start >= now) {
      throw new SummaryWindowError('SINCE_FUTURE', 'since 开始时间不能是未来或当前时间。');
    }
    if (now - start > maxSinceDays * DAY_MS) {
      throw new SummaryWindowError(
        'SINCE_TOO_OLD',
        `since 开始时间过早；最多可回溯 ${maxSinceDays} 天。`
      );
    }
    return manualWindow('since', timezone, start, now, text, 'EXPLICIT');
  }

  throw new SummaryWindowError(
    'INVALID_ARGUMENT',
    `摘要参数无效。可用：!summary、!summary Nh（1-${maxHours}）、!summary today、!summary yesterday、!summary since YYYY-MM-DD HH:mm。`
  );
}

module.exports = {
  DAY_MS,
  DEFAULT_MAX_MANUAL_HOURS,
  DEFAULT_MAX_SINCE_DAYS,
  HOUR_MS,
  SummaryWindowError,
  currentScheduledSlotStart,
  parseManualSummaryWindow,
};
