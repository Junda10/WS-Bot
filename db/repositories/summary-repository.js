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
      if (created) return { record: created, created: true, reclaimed: false };

      const existing = this.byWindow.get(
        values.chatId, values.reportType, values.windowStart, values.windowEnd
      );
      assertIdempotent(existing, { scheduled_for: values.scheduledFor }, ['scheduled_for'], 'summary run');
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

module.exports = { DEFAULT_LEASE_MS, REPORT_TYPES, SummaryRepository };
