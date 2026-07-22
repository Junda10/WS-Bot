'use strict';

const crypto = require('crypto');
const {
  assertIdempotent,
  immediate,
  optionalString,
  requireDatabase,
  requireInteger,
  requireString,
  requireTimestamp,
  uid,
} = require('./shared');

const REPORT_TYPES = new Set(['AUTO_10', 'AUTO_14', 'AUTO_20', 'MANUAL', 'RECOVERY']);
const AUTOMATIC_REPORT_TYPES = new Set(['AUTO_10', 'AUTO_14', 'AUTO_20']);
const DEFAULT_LEASE_MS = 60_000;

function reportType(value) {
  const normalized = requireString(value, 'reportType', { max: 30 }).toUpperCase();
  if (!REPORT_TYPES.has(normalized)) throw new TypeError(`Unsupported reportType: ${value}`);
  return normalized;
}

function leaseExpiry(now, value, name = 'leaseMs') {
  const leaseMs = requireInteger(value ?? DEFAULT_LEASE_MS, name, { min: 1 });
  if (leaseMs > 86_400_000 || now > Number.MAX_SAFE_INTEGER - leaseMs) {
    throw new RangeError(`${name} must not exceed one day or overflow a timestamp`);
  }
  return now + leaseMs;
}

function manifestHash(parts) {
  return crypto.createHash('sha256')
    .update(parts.map((part) => `${part.part_index}:${part.content_hash}`).join('\n'))
    .digest('hex');
}

class SummaryRepository {
  constructor(db) {
    this.db = requireDatabase(db);
    this.byWindow = db.prepare(`
      SELECT * FROM summary_runs
      WHERE chat_id = ? AND report_type = ? AND window_start = ? AND window_end = ?
    `);
  }

  claim(input) {
    const now = requireTimestamp(input.now, 'now');
    const values = {
      runUid: uid(input.runUid, 'runUid'),
      chatId: requireInteger(input.chatId, 'chatId', { min: 1 }),
      reportType: reportType(input.reportType),
      windowStart: requireTimestamp(input.windowStart, 'windowStart'),
      windowEnd: requireTimestamp(input.windowEnd, 'windowEnd'),
      scheduledFor: requireTimestamp(input.scheduledFor, 'scheduledFor'),
      now,
      leaseExpiresAt: leaseExpiry(now, input.leaseMs),
    };
    if (values.windowEnd <= values.windowStart) {
      throw new RangeError('windowEnd must be greater than windowStart');
    }
    return immediate(this.db, () => {
      if (AUTOMATIC_REPORT_TYPES.has(values.reportType)) {
        const owner = this.db.prepare(`
          SELECT r.* FROM summary_run_coverage c
          JOIN summary_runs r ON r.id = c.run_id
          WHERE c.chat_id = ? AND c.report_type = ?
            AND c.window_start = ? AND c.window_end = ?
        `).get(values.chatId, values.reportType, values.windowStart, values.windowEnd);
        if (owner && owner.report_type !== values.reportType) {
          return {
            record: owner,
            created: false,
            reclaimed: false,
            coveredByOther: true,
          };
        }
      }

      const created = this.db.prepare(`
        INSERT INTO summary_runs (
          run_uid, chat_id, report_type, window_start, window_end, scheduled_for,
          status, attempt_count, claimed_at, lease_expires_at, created_at, updated_at
        ) VALUES (
          @runUid, @chatId, @reportType, @windowStart, @windowEnd, @scheduledFor,
          'RUNNING', 1, @now, @leaseExpiresAt, @now, @now
        ) ON CONFLICT(chat_id, report_type, window_start, window_end) DO NOTHING
        RETURNING *
      `).get(values);
      const existing = created || this.byWindow.get(
        values.chatId, values.reportType, values.windowStart, values.windowEnd
      );
      assertIdempotent(existing, { scheduled_for: values.scheduledFor }, ['scheduled_for'], 'summary run');

      if (AUTOMATIC_REPORT_TYPES.has(values.reportType)) {
        this.db.prepare(`
          INSERT INTO summary_run_coverage (
            run_id, chat_id, report_type, window_start, window_end,
            scheduled_for, coverage_kind, created_at
          ) VALUES (
            @runId, @chatId, @reportType, @windowStart, @windowEnd,
            @scheduledFor, 'DIRECT', @now
          ) ON CONFLICT(chat_id, report_type, window_start, window_end) DO NOTHING
        `).run({ ...values, runId: existing.id });
        const coverage = this.db.prepare(`
          SELECT run_id FROM summary_run_coverage
          WHERE chat_id = ? AND report_type = ? AND window_start = ? AND window_end = ?
        `).get(values.chatId, values.reportType, values.windowStart, values.windowEnd);
        if (coverage.run_id !== existing.id) {
          throw new Error('Scheduled summary window was claimed concurrently by recovery');
        }
      }

      if (created) return { record: created, created: true, reclaimed: false };
      if (existing.status === 'SUCCEEDED') {
        return { record: existing, created: false, reclaimed: false };
      }

      const reclaimed = this.db.prepare(`
        UPDATE summary_runs
        SET status = 'RUNNING', attempt_count = attempt_count + 1,
            claimed_at = @now, lease_expires_at = @leaseExpiresAt,
            completed_at = NULL, updated_at = @now, last_error = NULL
        WHERE id = @id AND (
          status IN ('PENDING', 'FAILED')
          OR (status = 'RUNNING' AND lease_expires_at <= @now)
        ) RETURNING *
      `).get({ id: existing.id, now, leaseExpiresAt: values.leaseExpiresAt });
      return {
        record: reclaimed || existing,
        created: false,
        reclaimed: Boolean(reclaimed),
      };
    });
  }

  claimRecovery(input) {
    if (!Array.isArray(input.windows) || input.windows.length < 2) {
      throw new TypeError('Combined recovery requires at least two constituent windows');
    }
    const windows = input.windows.map((window) => ({
      chatId: requireInteger(window.chatId ?? input.chatId, 'chatId', { min: 1 }),
      reportType: reportType(window.reportType),
      windowStart: requireTimestamp(window.windowStart, 'windowStart'),
      windowEnd: requireTimestamp(window.windowEnd, 'windowEnd'),
      scheduledFor: requireTimestamp(window.scheduledFor, 'scheduledFor'),
    }));
    if (windows.some((window) => !AUTOMATIC_REPORT_TYPES.has(window.reportType))) {
      throw new TypeError('Recovery coverage may contain only automatic report windows');
    }
    const chatId = requireInteger(input.chatId, 'chatId', { min: 1 });
    if (windows.some((window) => window.chatId !== chatId || window.windowEnd <= window.windowStart)) {
      throw new RangeError('Recovery windows must belong to one chat and have valid boundaries');
    }
    const sorted = [...windows].sort((left, right) => left.scheduledFor - right.scheduledFor
      || left.reportType.localeCompare(right.reportType, 'en'));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const now = requireTimestamp(input.now, 'now');
    const claimInput = {
      runUid: uid(input.runUid, 'runUid'),
      chatId,
      reportType: 'RECOVERY',
      windowStart: first.windowStart,
      windowEnd: last.windowEnd,
      scheduledFor: last.scheduledFor,
      now,
      leaseExpiresAt: leaseExpiry(now, input.leaseMs),
    };

    return immediate(this.db, () => {
      const owners = sorted.map((window) => this.db.prepare(`
        SELECT c.run_id, r.report_type FROM summary_run_coverage c
        JOIN summary_runs r ON r.id = c.run_id
        WHERE c.chat_id = ? AND c.report_type = ?
          AND c.window_start = ? AND c.window_end = ?
      `).get(chatId, window.reportType, window.windowStart, window.windowEnd) || null);
      const ownerIds = new Set(owners.filter(Boolean).map((owner) => owner.run_id));
      if (ownerIds.size > 1 || (ownerIds.size === 1 && owners.some((owner) => owner === null))) {
        return { record: null, conflict: true, created: false, reclaimed: false };
      }
      if (owners.some((owner) => owner && owner.report_type !== 'RECOVERY')) {
        return { record: null, conflict: true, created: false, reclaimed: false };
      }

      let run = this.byWindow.get(chatId, 'RECOVERY', first.windowStart, last.windowEnd);
      let created = false;
      if (!run) {
        run = this.db.prepare(`
          INSERT INTO summary_runs (
            run_uid, chat_id, report_type, window_start, window_end, scheduled_for,
            status, attempt_count, claimed_at, lease_expires_at, created_at, updated_at
          ) VALUES (
            @runUid, @chatId, 'RECOVERY', @windowStart, @windowEnd, @scheduledFor,
            'RUNNING', 1, @now, @leaseExpiresAt, @now, @now
          ) RETURNING *
        `).get(claimInput);
        created = true;
      } else {
        assertIdempotent(run, { scheduled_for: last.scheduledFor }, ['scheduled_for'], 'recovery run');
      }
      if (ownerIds.size === 1 && !ownerIds.has(run.id)) {
        return { record: null, conflict: true, created: false, reclaimed: false };
      }

      for (const window of sorted) {
        this.db.prepare(`
          INSERT INTO summary_run_coverage (
            run_id, chat_id, report_type, window_start, window_end,
            scheduled_for, coverage_kind, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'COMBINED_RECOVERY', ?)
          ON CONFLICT(chat_id, report_type, window_start, window_end) DO NOTHING
        `).run(run.id, chatId, window.reportType, window.windowStart,
          window.windowEnd, window.scheduledFor, now);
      }
      if (created) return { record: run, conflict: false, created: true, reclaimed: false };
      if (run.status === 'SUCCEEDED') {
        return { record: run, conflict: false, created: false, reclaimed: false };
      }
      const reclaimed = this.db.prepare(`
        UPDATE summary_runs
        SET status = 'RUNNING', attempt_count = attempt_count + 1,
            claimed_at = @now, lease_expires_at = @leaseExpiresAt,
            completed_at = NULL, updated_at = @now, last_error = NULL
        WHERE id = @id AND (
          status IN ('PENDING', 'FAILED')
          OR (status = 'RUNNING' AND lease_expires_at <= @now)
        ) RETURNING *
      `).get({ id: run.id, now, leaseExpiresAt: claimInput.leaseExpiresAt });
      return {
        record: reclaimed || run,
        conflict: false,
        created: false,
        reclaimed: Boolean(reclaimed),
      };
    });
  }

  findById(runId) {
    return this.db.prepare('SELECT * FROM summary_runs WHERE id = ?').get(
      requireInteger(runId, 'runId', { min: 1 })
    ) || null;
  }

  findByUid(runUid) {
    return this.db.prepare('SELECT * FROM summary_runs WHERE run_uid = ?').get(
      requireString(runUid, 'runUid', { max: 200 })
    ) || null;
  }

  /**
   * Read-only cursor lookup for manual summaries. Manual commands must never
   * claim, update, or otherwise advance an automatic report run.
   */
  latestSuccessfulAutomatic(chatId, atOrBefore = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare(`
      SELECT * FROM summary_runs
      WHERE chat_id = @chatId AND status = 'SUCCEEDED'
        AND report_type IN ('AUTO_10', 'AUTO_14', 'AUTO_20')
        AND window_end <= @atOrBefore
      ORDER BY window_end DESC, completed_at DESC, id DESC
      LIMIT 1
    `).get({
      chatId: requireInteger(chatId, 'chatId', { min: 1 }),
      atOrBefore: requireTimestamp(atOrBefore, 'atOrBefore'),
    }) || null;
  }

  listCoverage(chatId, windows) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    if (!Array.isArray(windows)) throw new TypeError('windows must be an array');
    return windows.map((window) => {
      const type = reportType(window.reportType);
      const start = requireTimestamp(window.windowStart, 'windowStart');
      const end = requireTimestamp(window.windowEnd, 'windowEnd');
      return this.db.prepare(`
        SELECT c.*, r.status AS run_status, r.report_type AS owner_report_type,
               r.manifest_sealed_at, r.lease_expires_at, r.last_error
        FROM summary_run_coverage c
        JOIN summary_runs r ON r.id = c.run_id
        WHERE c.chat_id = ? AND c.report_type = ?
          AND c.window_start = ? AND c.window_end = ?
      `).get(id, type, start, end) || null;
    });
  }

  addPart(input) {
    const content = requireString(input.content, 'content', { max: 1000000 });
    const values = {
      partUid: uid(input.partUid, 'partUid'),
      runId: requireInteger(input.runId, 'runId', { min: 1 }),
      partIndex: requireInteger(input.partIndex, 'partIndex'),
      content,
      contentHash: crypto.createHash('sha256').update(content).digest('hex'),
      now: requireTimestamp(input.now, 'now'),
    };
    return immediate(this.db, () => {
      const existing = this.db.prepare(
        'SELECT * FROM summary_run_parts WHERE run_id = ? AND part_index = ?'
      ).get(values.runId, values.partIndex);
      if (existing) {
        assertIdempotent(existing, { content_hash: values.contentHash }, ['content_hash'], 'summary part');
        return { record: existing, created: false };
      }
      const created = this.db.prepare(`
        INSERT INTO summary_run_parts (
          part_uid, run_id, part_index, content, content_hash, status, created_at, updated_at
        ) VALUES (
          @partUid, @runId, @partIndex, @content, @contentHash, 'PENDING', @now, @now
        ) RETURNING *
      `).get(values);
      return { record: created, created: true };
    });
  }

  listParts(runId) {
    return this.db.prepare(`
      SELECT * FROM summary_run_parts WHERE run_id = ? ORDER BY part_index
    `).all(requireInteger(runId, 'runId', { min: 1 }));
  }

  persistManifest(runId, contents, now, partUidFactory = null) {
    const id = requireInteger(runId, 'runId', { min: 1 });
    const timestamp = requireTimestamp(now, 'now');
    if (!Array.isArray(contents) || contents.length === 0) {
      throw new TypeError('contents must contain at least one summary part');
    }
    return immediate(this.db, () => {
      const run = this.findById(id);
      if (!run) return null;
      if (run.manifest_sealed_at !== null) {
        return { run, parts: this.listParts(id), created: false };
      }
      for (let index = 0; index < contents.length; index += 1) {
        this.addPart({
          partUid: partUidFactory ? partUidFactory(index) : `${run.run_uid}-part-${index + 1}`,
          runId: id,
          partIndex: index,
          content: contents[index],
          now: timestamp,
        });
      }
      const sealed = this.seal(id, timestamp);
      return { run: sealed, parts: this.listParts(id), created: true };
    });
  }

  seal(runId, now) {
    const id = requireInteger(runId, 'runId', { min: 1 });
    const timestamp = requireTimestamp(now, 'now');
    return immediate(this.db, () => {
      const run = this.db.prepare('SELECT * FROM summary_runs WHERE id = ?').get(id);
      if (!run) return null;
      const parts = this.listParts(id);
      if (!parts.length) throw new Error('Cannot seal an empty summary manifest');
      if (parts.some((part, index) => part.part_index !== index)) {
        throw new Error('Summary part indexes must be contiguous from zero');
      }
      const hash = manifestHash(parts);
      if (run.manifest_sealed_at !== null) {
        assertIdempotent(run, {
          expected_part_count: parts.length,
          manifest_hash: hash,
        }, ['expected_part_count', 'manifest_hash'], 'summary manifest');
        return run;
      }
      const sealed = this.db.prepare(`
        UPDATE summary_runs
        SET manifest_sealed_at = @now, expected_part_count = @count,
            manifest_hash = @hash, updated_at = @now
        WHERE id = @id AND status = 'RUNNING' AND manifest_sealed_at IS NULL
        RETURNING *
      `).get({ id, now: timestamp, count: parts.length, hash });
      if (!sealed) throw new Error('Only an active summary run can be sealed');
      return sealed;
    });
  }

  markPartSending(partId, now, options = {}) {
    const timestamp = requireTimestamp(now, 'now');
    const expiry = leaseExpiry(timestamp, options.leaseMs, 'sendLeaseMs');
    return this.db.prepare(`
      UPDATE summary_run_parts
      SET status = 'SENDING', attempt_count = attempt_count + 1,
          send_lease_expires_at = @expiry, updated_at = @now, last_error = NULL
      WHERE id = @id
        AND (status IN ('PENDING', 'FAILED')
             OR (status = 'SENDING' AND send_lease_expires_at <= @now))
        AND EXISTS (
          SELECT 1 FROM summary_runs r
          WHERE r.id = summary_run_parts.run_id
            AND r.status = 'RUNNING' AND r.manifest_sealed_at IS NOT NULL
        )
      RETURNING *
    `).get({
      id: requireInteger(partId, 'partId', { min: 1 }), now: timestamp, expiry,
    }) || null;
  }

  markPartSent(input) {
    const partId = requireInteger(input.partId, 'partId', { min: 1 });
    const whatsappMessageId = requireString(
      input.whatsappMessageId, 'whatsappMessageId', { max: 500 }
    );
    const now = requireTimestamp(input.now, 'now');
    return immediate(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM summary_run_parts WHERE id = ?').get(partId);
      if (!existing) return null;
      if (existing.status === 'SENT') {
        assertIdempotent(existing, {
          whatsapp_message_id: whatsappMessageId,
        }, ['whatsapp_message_id'], 'summary part acknowledgement');
        return existing;
      }
      return this.db.prepare(`
        UPDATE summary_run_parts
        SET status = 'SENT', whatsapp_message_id = @whatsappMessageId,
            sent_at = @now, send_lease_expires_at = NULL,
            updated_at = @now, last_error = NULL
        WHERE id = @partId AND status IN ('PENDING', 'SENDING', 'FAILED')
          AND EXISTS (
            SELECT 1 FROM summary_runs r
            WHERE r.id = summary_run_parts.run_id
              AND r.status = 'RUNNING' AND r.manifest_sealed_at IS NOT NULL
          )
        RETURNING *
      `).get({ partId, whatsappMessageId, now }) || null;
    });
  }

  markPartFailed(input) {
    return this.db.prepare(`
      UPDATE summary_run_parts
      SET status = 'FAILED', send_lease_expires_at = NULL,
          last_error = @error, updated_at = @now
      WHERE id = @partId AND status <> 'SENT'
        AND EXISTS (
          SELECT 1 FROM summary_runs r
          WHERE r.id = summary_run_parts.run_id AND r.status <> 'SUCCEEDED'
        )
      RETURNING *
    `).get({
      partId: requireInteger(input.partId, 'partId', { min: 1 }),
      error: optionalString(input.error, 'error', { max: 100000 }),
      now: requireTimestamp(input.now, 'now'),
    }) || null;
  }

  complete(runId, now) {
    const id = requireInteger(runId, 'runId', { min: 1 });
    const timestamp = requireTimestamp(now, 'now');
    return immediate(this.db, () => {
      const run = this.db.prepare('SELECT * FROM summary_runs WHERE id = ?').get(id);
      if (!run) return null;
      if (run.status === 'SUCCEEDED') return run;
      if (run.manifest_sealed_at === null) throw new Error('Cannot complete an unsealed summary run');
      const counts = this.db.prepare(`
        SELECT count(*) AS total,
               sum(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) AS sent
        FROM summary_run_parts WHERE run_id = ?
      `).get(id);
      if (counts.total !== run.expected_part_count || counts.sent !== counts.total) {
        throw new Error('Cannot complete summary run until every sealed part is sent');
      }
      return this.db.prepare(`
        UPDATE summary_runs
        SET status = 'SUCCEEDED', completed_at = ?, lease_expires_at = NULL,
            updated_at = ?, last_error = NULL
        WHERE id = ? AND status <> 'SUCCEEDED' RETURNING *
      `).get(timestamp, timestamp, id)
        || this.db.prepare('SELECT * FROM summary_runs WHERE id = ?').get(id)
        || null;
    });
  }

  fail(runId, error, now) {
    return this.db.prepare(`
      UPDATE summary_runs
      SET status = 'FAILED', lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status <> 'SUCCEEDED' RETURNING *
    `).get(
      error == null ? null : String(error),
      requireTimestamp(now, 'now'),
      requireInteger(runId, 'runId', { min: 1 })
    ) || null;
  }
}

module.exports = {
  AUTOMATIC_REPORT_TYPES,
  DEFAULT_LEASE_MS,
  REPORT_TYPES,
  SummaryRepository,
};
