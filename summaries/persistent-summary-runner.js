'use strict';

const crypto = require('crypto');
const { scheduledReportWindow, requireTimezone } = require('./window');

const SLOT_REPORT_TYPES = Object.freeze({
  '10:00': 'AUTO_10',
  '14:00': 'AUTO_14',
  '20:00': 'AUTO_20',
});

function normalizeError(error) {
  return Array.from(String(error?.message || error || 'Unknown scheduled summary failure'))
    .slice(0, 2000).join('');
}

function reportMarker(run, partIndex) {
  const identity = [run.chat_id, run.report_type, run.window_start, run.window_end].join(':');
  const reportHash = crypto.createHash('sha256').update(identity).digest('hex')
    .slice(0, 20).toUpperCase();
  return `WSB-RPT-${reportHash}-P${partIndex + 1}`;
}

function attachMarkers(run, parts) {
  return parts.map((content, index) => `${content}\n\n[${reportMarker(run, index)}]`);
}

class PersistentSummaryRunner {
  constructor({
    repositories,
    summaryService,
    adapter,
    chat,
    timezone = 'Asia/Kuala_Lumpur',
    clock = Date.now,
    logger = console,
    leaseMs = 5 * 60_000,
    sendLeaseMs = 60_000,
    maxAttemptsPerInvocation = 3,
    backoffMs = [1000, 5000],
    wait = null,
  } = {}) {
    if (!repositories?.summaries?.claim || !repositories?.chats) {
      throw new TypeError('PersistentSummaryRunner requires summary and chat repositories');
    }
    if (!summaryService || typeof summaryService.build !== 'function') {
      throw new TypeError('summaryService.build is required');
    }
    if (!adapter || typeof adapter.sendText !== 'function') {
      throw new TypeError('adapter.sendText is required');
    }
    if (!chat?.id || !chat?.jid) throw new TypeError('an authorized chat record is required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.repositories = repositories;
    this.summaryService = summaryService;
    this.adapter = adapter;
    this.chat = chat;
    this.timezone = requireTimezone(timezone);
    this.clock = clock;
    this.logger = logger;
    this.leaseMs = leaseMs;
    this.sendLeaseMs = sendLeaseMs;
    this.maxAttemptsPerInvocation = maxAttemptsPerInvocation;
    this.backoffMs = backoffMs;
    this.waitOverride = wait;
    this.inFlight = new Map();
    this.waitTimers = new Set();
    this.stopped = false;
  }

  _now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('clock returned invalid UTC milliseconds');
    return value;
  }

  _wait(ms) {
    if (this.waitOverride) return this.waitOverride(ms);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = { timer: null, resolve };
      entry.timer = setTimeout(() => {
        this.waitTimers.delete(entry);
        resolve(true);
      }, ms);
      entry.timer.unref?.();
      this.waitTimers.add(entry);
    });
  }

  _windowDescriptor(slot, localDate) {
    const window = scheduledReportWindow({
      slot,
      localDate,
      timezone: this.timezone,
      clock: this.clock,
    });
    return {
      ...window,
      reportType: SLOT_REPORT_TYPES[window.slot],
      windowStart: window.startUtcMs,
      windowEnd: window.endUtcMs,
      scheduledFor: window.scheduledForUtcMs,
    };
  }

  async triggerSlot(slot, options = {}) {
    return this.runWindow(this._windowDescriptor(slot, options.localDate), {
      delayed: options.delayed === true,
    });
  }

  async runWindow(window, options = {}) {
    const claim = () => this.repositories.summaries.claim({
      chatId: this.chat.id,
      reportType: window.reportType,
      windowStart: window.windowStart ?? window.startUtcMs,
      windowEnd: window.windowEnd ?? window.endUtcMs,
      scheduledFor: window.scheduledFor ?? window.scheduledForUtcMs,
      now: this._now(),
      leaseMs: this.leaseMs,
    });
    return this._claimAndRun(claim, {
      window: {
        ...window,
        startUtcMs: window.windowStart ?? window.startUtcMs,
        endUtcMs: window.windowEnd ?? window.endUtcMs,
        scheduledForUtcMs: window.scheduledFor ?? window.scheduledForUtcMs,
      },
      delayed: options.delayed === true,
      constituentWindows: [],
    });
  }

  async runCombined(windows) {
    if (!Array.isArray(windows) || windows.length < 2) {
      throw new TypeError('runCombined requires at least two windows');
    }
    const normalized = windows.map((window) => ({
      ...window,
      chatId: this.chat.id,
      windowStart: window.windowStart ?? window.startUtcMs,
      windowEnd: window.windowEnd ?? window.endUtcMs,
      scheduledFor: window.scheduledFor ?? window.scheduledForUtcMs,
    })).sort((left, right) => left.scheduledFor - right.scheduledFor);
    const claim = () => this.repositories.summaries.claimRecovery({
      chatId: this.chat.id,
      windows: normalized,
      now: this._now(),
      leaseMs: this.leaseMs,
    });
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    return this._claimAndRun(claim, {
      window: {
        kind: 'RECOVERY',
        slot: null,
        timezone: this.timezone,
        startUtcMs: first.windowStart,
        endUtcMs: last.windowEnd,
        scheduledForUtcMs: last.scheduledFor,
        previousDay: null,
      },
      delayed: true,
      constituentWindows: normalized,
    });
  }

  async _claimAndRun(claim, buildInput) {
    if (this.stopped) return { status: 'STOPPED' };
    const authorizedChat = this.repositories.chats.findByJid(this.chat.jid, { includeDeleted: true });
    if (!authorizedChat || authorizedChat.enabled !== 1 || authorizedChat.deleted_at !== null) {
      return { status: 'WAITING_FOR_AUTHORIZED_CHAT' };
    }
    let claimed;
    try {
      claimed = claim();
    } catch (error) {
      this.logger.error?.(`Scheduled summary claim failed: ${normalizeError(error)}`);
      throw error;
    }
    if (claimed.conflict || claimed.coveredByOther) return { status: 'COVERED' };
    if (!claimed.record) return { status: 'BUSY' };
    if (claimed.record.status === 'SUCCEEDED') return { status: 'SUCCEEDED', run: claimed.record };
    if (!claimed.created && !claimed.reclaimed) return { status: 'BUSY', run: claimed.record };

    const existing = this.inFlight.get(claimed.record.id);
    if (existing) return existing;
    const operation = this._retry(claimed, claim, buildInput)
      .finally(() => this.inFlight.delete(claimed.record.id));
    this.inFlight.set(claimed.record.id, operation);
    return operation;
  }

  async _retry(initialClaim, claim, buildInput) {
    let current = initialClaim;
    let lastError = null;
    for (let attempt = 0; attempt < this.maxAttemptsPerInvocation && !this.stopped; attempt += 1) {
      try {
        const run = await this._execute(current.record, buildInput);
        return { status: 'SUCCEEDED', run };
      } catch (error) {
        lastError = error;
        const message = normalizeError(error);
        this.repositories.summaries.fail(current.record.id, message, this._now());
        this.logger.error?.(`Scheduled summary run ${current.record.run_uid} failed: ${message}`);
        if (attempt + 1 >= this.maxAttemptsPerInvocation || this.stopped) break;
        const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 1000;
        if (!await this._wait(delay) || this.stopped) break;
        current = claim();
        if (!current.record || current.conflict || current.coveredByOther
            || (!current.created && !current.reclaimed)) break;
      }
    }
    return { status: 'FAILED', run: this.repositories.summaries.findById(initialClaim.record.id), error: lastError };
  }

  _markPartSent(part, whatsappMessageId, now) {
    const acknowledged = this.repositories.summaries.markPartSent({
      partId: part.id,
      whatsappMessageId,
      now,
    });
    if (!acknowledged
        || acknowledged.id !== part.id
        || acknowledged.status !== 'SENT'
        || acknowledged.whatsapp_message_id !== whatsappMessageId) {
      throw new Error(`Summary part ${part.part_index + 1} acknowledgement invariant mismatch`);
    }
    return acknowledged;
  }

  async _execute(run, buildInput) {
    let current = this.repositories.summaries.findById(run.id);
    if (current.manifest_sealed_at === null) {
      const built = await this.summaryService.build({
        chatId: this.chat.id,
        window: buildInput.window,
        now: this._now(),
        delayed: buildInput.delayed,
        constituentWindows: buildInput.constituentWindows,
      });
      const markedParts = attachMarkers(current, built.parts);
      this.repositories.summaries.persistManifest(current.id, markedParts, this._now());
      current = this.repositories.summaries.findById(current.id);
    }

    const parts = this.repositories.summaries.listParts(current.id);
    for (const part of parts) {
      if (part.status === 'SENT') continue;
      const sending = this.repositories.summaries.markPartSending(part.id, this._now(), {
        leaseMs: this.sendLeaseMs,
      });
      if (!sending) throw new Error(`Part ${part.part_index + 1} is leased by another sender`);
      const marker = reportMarker(current, part.part_index);
      try {
        let lookup = { available: false, receipt: null, reason: 'adapter lookup unavailable' };
        if (typeof this.adapter.findRecentOutgoingByMarker === 'function') {
          lookup = await this.adapter.findRecentOutgoingByMarker(this.chat.jid, marker);
        }
        if (lookup.available && lookup.receipt?.id) {
          this._markPartSent(
            part,
            lookup.receipt.id,
            lookup.receipt.sentAt ?? this._now()
          );
          this.logger.warn?.(`Recovered sent summary part by marker ${marker}; resend suppressed`);
          continue;
        }
        if (!lookup.available) {
          this.logger.warn?.(`Summary marker lookup unavailable (${lookup.reason || 'unknown'}); using safe at-least-once fallback for ${marker}`);
        }
        const receipt = await this.adapter.sendText(this.chat.jid, sending.content);
        if (!receipt?.id) throw new Error('WhatsApp send succeeded without a durable message ID');
        this._markPartSent(part, receipt.id, receipt.sentAt ?? this._now());
      } catch (error) {
        this.repositories.summaries.markPartFailed({
          partId: part.id,
          error: normalizeError(error),
          now: this._now(),
        });
        throw error;
      }
    }
    return this.repositories.summaries.complete(current.id, this._now());
  }

  stop() {
    this.stopped = true;
    for (const entry of this.waitTimers) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.waitTimers.clear();
  }

  async drain({ timeoutMs = 10_000 } = {}) {
    const active = [...this.inFlight.values()];
    if (!active.length) return { timedOut: false, remaining: 0 };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([Promise.allSettled(active).then(() => 'done'), timeout]);
    clearTimeout(timer);
    return { timedOut: result === 'timeout', remaining: result === 'timeout' ? this.inFlight.size : 0 };
  }
}

module.exports = {
  PersistentSummaryRunner,
  SLOT_REPORT_TYPES,
  attachMarkers,
  normalizeError,
  reportMarker,
};
