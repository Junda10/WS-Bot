'use strict';

const { requireInteger, requireTimestamp } = require('../db/repositories/shared');
const { scheduledReportWindow, requireTimezone } = require('./window');

const REPORT_EVENT_BUCKETS = Object.freeze({
  CREATED: 'created',
  REPLY_CONFIRMED: 'replies',
  RESOLVED: 'resolved',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
  RESTORED: 'restored',
  UPDATED: 'updated',
});

function parseObject(value) {
  if (value == null) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseUncertainties(value) {
  if (value == null) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function requireRepositories(repositories) {
  if (!repositories?.issues?.listReportEvents
      || !repositories?.issues?.historicalReportStats
      || !repositories?.issues?.listCurrentReportIssues
      || !repositories?.messages?.countWindow) {
    throw new TypeError('PM reports require message and issue reporting repositories');
  }
  return repositories;
}

function requireNow(clock) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  return requireTimestamp(clock(), 'clock result');
}

function normalizeWindow(window, timezone) {
  if (!window || typeof window !== 'object') throw new TypeError('window is required');
  const startUtcMs = requireTimestamp(window.startUtcMs, 'window.startUtcMs');
  const endUtcMs = requireTimestamp(window.endUtcMs, 'window.endUtcMs');
  if (endUtcMs <= startUtcMs) throw new RangeError('window end must be greater than start');
  const zone = requireTimezone(window.timezone || timezone);
  const previousDay = window.previousDay == null ? null : {
    startUtcMs: requireTimestamp(window.previousDay.startUtcMs, 'window.previousDay.startUtcMs'),
    endUtcMs: requireTimestamp(window.previousDay.endUtcMs, 'window.previousDay.endUtcMs'),
  };
  if (previousDay && previousDay.endUtcMs <= previousDay.startUtcMs) {
    throw new RangeError('previous-day window end must be greater than start');
  }
  return {
    kind: window.kind || 'MANUAL',
    slot: window.slot || null,
    timezone: zone,
    startUtcMs,
    endUtcMs,
    scheduledForUtcMs: window.scheduledForUtcMs == null
      ? null
      : requireTimestamp(window.scheduledForUtcMs, 'window.scheduledForUtcMs'),
    previousDay,
  };
}

function reportEvent(row) {
  return Object.freeze({
    id: row.id,
    issueId: row.issue_id,
    publicId: row.historical_public_id || null,
    title: row.historical_title || null,
    status: row.historical_status || null,
    type: row.event_type,
    actorJid: row.actor_jid,
    occurredAtUtcMs: row.occurred_at,
    sourceWhatsappMessageId: row.source_whatsapp_message_id,
    replyText: row.reply_text,
    reason: row.reason,
    before: parseObject(row.before_json),
    after: parseObject(row.after_json),
  });
}

function reportQueueIssue(row, now) {
  const firstRepliedAtUtcMs = row.first_replied_at;
  return Object.freeze({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    status: row.status,
    createdByJid: row.created_by_jid,
    ownerJid: row.owner_jid,
    createdAtUtcMs: row.created_at,
    updatedAtUtcMs: row.updated_at,
    firstRepliedAtUtcMs,
    waitingDurationMs: row.status === 'WAITING_TEVAU'
      ? Math.max(0, now - row.created_at)
      : null,
    firstResponseDurationMs: firstRepliedAtUtcMs == null
      ? null
      : Math.max(0, firstRepliedAtUtcMs - row.created_at),
    attachments: Object.freeze({
      count: row.attachment_count,
      parsePendingCount: row.attachment_parse_pending_count,
      parseFailedCount: row.attachment_parse_failed_count,
      savedUnparsedCount: row.attachment_saved_unparsed_count,
    }),
  });
}

function buildPmReportModel({
  repositories,
  chatId,
  window,
  now,
  timezone,
}) {
  const repos = requireRepositories(repositories);
  const id = requireInteger(chatId, 'chatId', { min: 1 });
  const generatedAtUtcMs = requireTimestamp(now, 'now');
  const normalizedWindow = normalizeWindow(window, timezone);
  const rows = repos.issues.listReportEvents(
    id,
    normalizedWindow.startUtcMs,
    normalizedWindow.endUtcMs
  );
  const changes = {
    created: [], replies: [], resolved: [], archived: [],
    deleted: [], restored: [], updated: [],
  };
  const dataGaps = [];
  for (const row of rows) {
    const event = reportEvent(row);
    changes[REPORT_EVENT_BUCKETS[row.event_type]].push(event);
    if (!event.publicId || !event.title) {
      dataGaps.push(Object.freeze({
        kind: 'EVENT_SNAPSHOT_MISSING',
        issueId: event.issueId,
        eventId: event.id,
        eventType: event.type,
      }));
    }
  }

  const current = repos.issues.listCurrentReportIssues(id);
  const queueRows = current.map((row) => reportQueueIssue(row, generatedAtUtcMs));
  const waitingTevau = queueRows.filter((issue) => issue.status === 'WAITING_TEVAU')
    .sort((left, right) => (
      right.waitingDurationMs - left.waitingDurationMs
      || left.createdAtUtcMs - right.createdAtUtcMs
      || left.id - right.id
    ));
  const repliedUnresolved = queueRows.filter((issue) => issue.status === 'REPLIED')
    .sort((left, right) => (
      left.createdAtUtcMs - right.createdAtUtcMs || left.id - right.id
    ));

  const uncertainties = [];
  for (const row of current) {
    for (const text of parseUncertainties(row.source_uncertainties_json)) {
      uncertainties.push(Object.freeze({
        kind: 'ISSUE_EXTRACTION_UNCERTAINTY',
        issueId: row.id,
        publicId: row.public_id,
        text,
      }));
    }
    if (row.source_extraction_status === 'FALLBACK') {
      dataGaps.push(Object.freeze({
        kind: 'ISSUE_EXTRACTION_FALLBACK',
        issueId: row.id,
        publicId: row.public_id,
        errorCode: row.source_ai_error_code,
      }));
    }
    const attachmentGapKinds = [
      ['ATTACHMENT_PARSE_PENDING', row.attachment_parse_pending_count],
      ['ATTACHMENT_PARSE_FAILED', row.attachment_parse_failed_count],
      ['ATTACHMENT_SAVED_UNPARSED', row.attachment_saved_unparsed_count],
    ];
    for (const [kind, count] of attachmentGapKinds) {
      if (count > 0) {
        dataGaps.push(Object.freeze({
          kind,
          issueId: row.id,
          publicId: row.public_id,
          count,
        }));
      }
    }
  }

  let previousDayStats = null;
  if (normalizedWindow.previousDay) {
    const stats = repos.issues.historicalReportStats(
      id,
      normalizedWindow.previousDay.startUtcMs,
      normalizedWindow.previousDay.endUtcMs
    );
    previousDayStats = Object.freeze({
      startUtcMs: normalizedWindow.previousDay.startUtcMs,
      endUtcMs: normalizedWindow.previousDay.endUtcMs,
      createdIssueCount: stats.created_issue_count,
      confirmedReplyIssueCount: stats.replied_issue_count,
      confirmedReplyEventCount: stats.reply_event_count,
      resolvedIssueCount: stats.resolved_issue_count,
      unresolvedAtEndIssueCount: stats.unresolved_at_end_issue_count,
    });
  }

  const eventCount = rows.length;
  return Object.freeze({
    schemaVersion: 1,
    source: 'SQLITE_DETERMINISTIC',
    aiUsed: false,
    chatId: id,
    timezone: normalizedWindow.timezone,
    generatedAtUtcMs,
    window: Object.freeze({
      kind: normalizedWindow.kind,
      slot: normalizedWindow.slot,
      startUtcMs: normalizedWindow.startUtcMs,
      endUtcMs: normalizedWindow.endUtcMs,
      scheduledForUtcMs: normalizedWindow.scheduledForUtcMs,
    }),
    messageCount: repos.messages.countWindow(
      id,
      normalizedWindow.startUtcMs,
      normalizedWindow.endUtcMs,
      { includeCommands: false, includeTombstones: false }
    ),
    changes: Object.freeze(Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [key, Object.freeze(value)])
    )),
    changeEventCount: eventCount,
    previousDayStats,
    queues: Object.freeze({
      waitingTevau: Object.freeze(waitingTevau),
      repliedUnresolved: Object.freeze(repliedUnresolved),
    }),
    uncertainties: Object.freeze(uncertainties),
    dataGaps: Object.freeze(dataGaps),
  });
}

class PmReportService {
  constructor({
    repositories,
    clock = Date.now,
    timezone = 'Asia/Kuala_Lumpur',
  } = {}) {
    this.repositories = requireRepositories(repositories);
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.clock = clock;
    this.timezone = requireTimezone(timezone);
  }

  build({ chatId, window }) {
    return buildPmReportModel({
      repositories: this.repositories,
      chatId,
      window,
      now: requireNow(this.clock),
      timezone: this.timezone,
    });
  }

  buildScheduled({ chatId, slot, localDate }) {
    // Capture once so date selection and waiting durations cannot straddle a
    // clock tick (or local midnight) under an injected or real clock.
    const now = requireNow(this.clock);
    const window = scheduledReportWindow({
      slot,
      localDate,
      timezone: this.timezone,
      clock: () => now,
    });
    return buildPmReportModel({
      repositories: this.repositories,
      chatId,
      window,
      now,
      timezone: this.timezone,
    });
  }
}

module.exports = {
  PmReportService,
  REPORT_EVENT_BUCKETS,
  buildPmReportModel,
};
