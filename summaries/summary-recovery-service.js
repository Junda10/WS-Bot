'use strict';

const { DateTime } = require('luxon');
const { SCHEDULED_SLOTS, requireTimezone, scheduledReportWindow } = require('./window');
const { SLOT_REPORT_TYPES } = require('./persistent-summary-runner');

function expectedWindows({ now, timezone = 'Asia/Kuala_Lumpur', recoveryHours = 24 }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be UTC milliseconds');
  if (!Number.isSafeInteger(recoveryHours) || recoveryHours < 1 || recoveryHours > 168) {
    throw new TypeError('recoveryHours must be an integer from 1 to 168');
  }
  const zone = requireTimezone(timezone);
  const cutoff = now - recoveryHours * 60 * 60_000;
  const localNow = DateTime.fromMillis(now, { zone });
  const days = Math.ceil(recoveryHours / 24) + 2;
  const windows = [];
  for (let offset = -days; offset <= 0; offset += 1) {
    const localDate = localNow.plus({ days: offset }).toFormat('yyyy-LL-dd');
    for (const slot of SCHEDULED_SLOTS) {
      const window = scheduledReportWindow({ slot, localDate, timezone: zone });
      if (window.scheduledForUtcMs <= cutoff || window.scheduledForUtcMs > now) continue;
      windows.push(Object.freeze({
        ...window,
        reportType: SLOT_REPORT_TYPES[slot],
        windowStart: window.startUtcMs,
        windowEnd: window.endUtcMs,
        scheduledFor: window.scheduledForUtcMs,
      }));
    }
  }
  return Object.freeze(windows.sort((left, right) => left.scheduledFor - right.scheduledFor));
}

function recoveryBatches(missingEntries) {
  const unowned = [];
  const owned = new Map();
  for (const entry of missingEntries) {
    if (!entry.owner) {
      unowned.push(entry.window);
      continue;
    }
    const key = entry.owner.run_id;
    if (!owned.has(key)) owned.set(key, { owner: entry.owner, windows: [] });
    owned.get(key).windows.push(entry.window);
  }

  const batches = [];
  for (const group of owned.values()) {
    batches.push({
      kind: group.owner.owner_report_type === 'RECOVERY' ? 'COMBINED' : 'DIRECT',
      windows: group.windows,
    });
  }
  if (unowned.length) {
    batches.push({ kind: unowned.length > 1 ? 'COMBINED' : 'DIRECT', windows: unowned });
  }
  return batches.sort((left, right) => left.windows[0].scheduledFor - right.windows[0].scheduledFor);
}

class SummaryRecoveryService {
  constructor({
    repositories,
    runner,
    chat,
    adapterReady = () => true,
    timezone = 'Asia/Kuala_Lumpur',
    recoveryHours = 24,
    clock = Date.now,
    logger = console,
  } = {}) {
    if (!repositories?.summaries?.listCoverage || !repositories?.chats?.findByJid) {
      throw new TypeError('SummaryRecoveryService requires summary and chat repositories');
    }
    if (!runner?.runWindow || !runner?.runCombined) {
      throw new TypeError('SummaryRecoveryService requires a persistent summary runner');
    }
    this.repositories = repositories;
    this.runner = runner;
    this.chat = chat;
    this.adapterReady = adapterReady;
    this.timezone = requireTimezone(timezone);
    this.recoveryHours = recoveryHours;
    this.clock = clock;
    this.logger = logger;
  }

  async recover() {
    if (!this.adapterReady()) return { status: 'WAITING_FOR_ADAPTER', missing: [] };
    const currentChat = this.repositories.chats.findByJid(this.chat.jid, { includeDeleted: true });
    if (!currentChat || currentChat.enabled !== 1 || currentChat.deleted_at !== null) {
      return { status: 'WAITING_FOR_AUTHORIZED_CHAT', missing: [] };
    }
    const now = this.clock();
    const expected = expectedWindows({
      now,
      timezone: this.timezone,
      recoveryHours: this.recoveryHours,
    });
    const coverage = this.repositories.summaries.listCoverage(this.chat.id, expected);
    const missingEntries = expected.map((window, index) => ({ window, owner: coverage[index] }))
      .filter(({ owner }) => {
        if (!owner) return true;
        if (owner.run_status === 'SUCCEEDED') return false;
        // A live cron/recovery owner wins the current-slot race. Durable FAILED,
        // PENDING, and expired RUNNING owners are explicitly recovered.
        return !(owner.run_status === 'RUNNING' && owner.lease_expires_at > now);
      });
    const missing = missingEntries.map((entry) => entry.window);
    if (missing.length === 0) return { status: 'NOTHING_MISSING', expected, missing };

    this.logger.warn?.(`Scheduled summary recovery found ${missing.length} missing window(s)`);
    const batches = recoveryBatches(missingEntries);
    const results = [];
    for (const batch of batches) {
      const result = batch.kind === 'COMBINED'
        ? await this.runner.runCombined(batch.windows)
        : await this.runner.runWindow(batch.windows[0], { delayed: true });
      results.push(result);
      if (result.status !== 'SUCCEEDED' && result.status !== 'COVERED') {
        return {
          status: result.status,
          expected,
          missing,
          batches,
          results,
          result,
        };
      }
    }
    return {
      status: 'RECOVERED',
      expected,
      missing,
      batches,
      results,
      result: results.at(-1),
    };
  }
}

module.exports = { SummaryRecoveryService, expectedWindows, recoveryBatches };
