'use strict';

const { DateTime } = require('luxon');

const DEFAULT_REPORT_TIMEZONE = 'Asia/Kuala_Lumpur';
const SCHEDULED_SLOTS = Object.freeze(['10:00', '14:00', '20:00']);
const SLOT_HOURS = Object.freeze({ '10:00': 10, '14:00': 14, '20:00': 20 });

function requireClock(clock) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  return clock;
}

function clockNow(clock) {
  const now = requireClock(clock)();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('clock must return a non-negative safe UTC millisecond integer');
  }
  return now;
}

function requireTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) {
    throw new TypeError('timezone must be a non-empty Luxon zone name');
  }
  const zone = timezone.trim();
  if (['local', 'system'].includes(zone.toLowerCase())) {
    throw new RangeError('System-local timezone aliases are not allowed');
  }
  const probe = DateTime.fromMillis(0, { zone });
  if (!probe.isValid) throw new RangeError(`Invalid timezone: ${timezone}`);
  return zone;
}

function requireLocalDate(localDate, timezone = DEFAULT_REPORT_TIMEZONE) {
  const zone = requireTimezone(timezone);
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) {
    throw new TypeError('localDate must use strict YYYY-MM-DD format');
  }
  const parsed = DateTime.fromISO(localDate, { zone, setZone: true });
  if (!parsed.isValid || parsed.toFormat('yyyy-LL-dd') !== localDate) {
    throw new RangeError(`Invalid localDate: ${localDate}`);
  }
  return localDate;
}

function normalizeSlot(slot) {
  const aliases = new Map([
    [10, '10:00'], [14, '14:00'], [20, '20:00'],
    ['10', '10:00'], ['14', '14:00'], ['20', '20:00'],
    ['10:00', '10:00'], ['14:00', '14:00'], ['20:00', '20:00'],
    ['AUTO_10', '10:00'], ['AUTO_14', '14:00'], ['AUTO_20', '20:00'],
  ]);
  const normalized = aliases.get(slot);
  if (!normalized) throw new RangeError(`Invalid scheduled report slot: ${slot}`);
  return normalized;
}

function localBoundaryToUtcMs({
  localDate,
  hour = 0,
  minute = 0,
  timezone = DEFAULT_REPORT_TIMEZONE,
}) {
  const zone = requireTimezone(timezone);
  const date = requireLocalDate(localDate, zone);
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
    throw new TypeError('hour must be an integer from 0 through 23');
  }
  if (!Number.isSafeInteger(minute) || minute < 0 || minute > 59) {
    throw new TypeError('minute must be an integer from 0 through 59');
  }
  const [year, month, day] = date.split('-').map(Number);
  const local = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone }
  );
  // Luxon shifts nonexistent wall times across DST gaps. A reporting boundary
  // must remain exact, so reject any shifted result instead of silently moving it.
  if (!local.isValid || local.year !== year || local.month !== month || local.day !== day
      || local.hour !== hour || local.minute !== minute) {
    throw new RangeError(`Invalid local boundary: ${date} ${hour}:${minute} in ${zone}`);
  }
  const value = local.toUTC().toMillis();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Local boundary is outside supported UTC millisecond range');
  }
  return value;
}

function shiftLocalDate(localDate, days, timezone = DEFAULT_REPORT_TIMEZONE) {
  const zone = requireTimezone(timezone);
  const date = requireLocalDate(localDate, zone);
  if (!Number.isSafeInteger(days)) throw new TypeError('days must be a safe integer');
  return DateTime.fromISO(date, { zone, setZone: true }).plus({ days }).toFormat('yyyy-LL-dd');
}

function localDayWindow(localDate, { timezone = DEFAULT_REPORT_TIMEZONE } = {}) {
  const zone = requireTimezone(timezone);
  const date = requireLocalDate(localDate, zone);
  const nextDate = shiftLocalDate(date, 1, zone);
  return Object.freeze({
    timezone: zone,
    startUtcMs: localBoundaryToUtcMs({ localDate: date, hour: 0, timezone: zone }),
    endUtcMs: localBoundaryToUtcMs({ localDate: nextDate, hour: 0, timezone: zone }),
  });
}

function scheduledReportWindow({
  slot,
  localDate,
  timezone = DEFAULT_REPORT_TIMEZONE,
  clock = Date.now,
} = {}) {
  const zone = requireTimezone(timezone);
  requireClock(clock);
  const scheduledSlot = normalizeSlot(slot);
  const reportDate = localDate === undefined
    ? DateTime.fromMillis(clockNow(clock), { zone }).toFormat('yyyy-LL-dd')
    : requireLocalDate(localDate, zone);
  const slotHour = SLOT_HOURS[scheduledSlot];
  const scheduledForUtcMs = localBoundaryToUtcMs({
    localDate: reportDate,
    hour: slotHour,
    timezone: zone,
  });

  let startDate = reportDate;
  let startHour;
  if (scheduledSlot === '10:00') {
    startDate = shiftLocalDate(reportDate, -1, zone);
    startHour = 20;
  } else if (scheduledSlot === '14:00') {
    startHour = 10;
  } else {
    startHour = 14;
  }

  const previousDay = scheduledSlot === '10:00'
    ? localDayWindow(shiftLocalDate(reportDate, -1, zone), { timezone: zone })
    : null;
  return Object.freeze({
    kind: 'SCHEDULED',
    slot: scheduledSlot,
    timezone: zone,
    startUtcMs: localBoundaryToUtcMs({
      localDate: startDate,
      hour: startHour,
      timezone: zone,
    }),
    endUtcMs: scheduledForUtcMs,
    scheduledForUtcMs,
    previousDay,
  });
}

function createWindowCalculator({
  timezone = DEFAULT_REPORT_TIMEZONE,
  clock = Date.now,
} = {}) {
  const zone = requireTimezone(timezone);
  requireClock(clock);
  return Object.freeze({
    scheduled(slot, localDate) {
      return scheduledReportWindow({ slot, localDate, timezone: zone, clock });
    },
    localDay(localDate) {
      return localDayWindow(localDate, { timezone: zone });
    },
    localBoundary(localDate, hour = 0, minute = 0) {
      return localBoundaryToUtcMs({ localDate, hour, minute, timezone: zone });
    },
  });
}

module.exports = {
  DEFAULT_REPORT_TIMEZONE,
  SCHEDULED_SLOTS,
  createWindowCalculator,
  localBoundaryToUtcMs,
  localDayWindow,
  normalizeSlot,
  requireLocalDate,
  requireTimezone,
  scheduledReportWindow,
  shiftLocalDate,
};
