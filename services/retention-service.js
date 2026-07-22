'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_CHUNK_SIZE = 250;

function chunks(values, size = DELETE_CHUNK_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function requirePositiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function maintenanceUid(operation) {
  return `${operation.toLowerCase()}:${Date.now()}:${crypto.randomUUID()}`;
}

class RetentionService {
  constructor({
    db,
    repositories,
    storage,
    messageDays = 30,
    replySessionGraceMs = DAY_MS,
    tempFileGraceMs = DAY_MS,
    clock = Date.now,
    logger = console,
    fsImpl = fs,
  } = {}) {
    if (!db?.prepare || !repositories?.attachments || !storage?.remove) {
      throw new TypeError('RetentionService requires db, repositories, and attachment storage');
    }
    this.db = db;
    this.repositories = repositories;
    this.storage = storage;
    this.messageDays = requirePositiveInteger(messageDays, 'messageDays', 3650);
    this.replySessionGraceMs = requirePositiveInteger(replySessionGraceMs, 'replySessionGraceMs');
    this.tempFileGraceMs = requirePositiveInteger(tempFileGraceMs, 'tempFileGraceMs');
    this.clock = clock;
    this.logger = logger;
    this.fs = fsImpl;
    this.active = null;
    this.accepting = true;
  }

  run() {
    if (!this.accepting) {
      const error = new Error('Retention service is stopping');
      error.code = 'STOPPED';
      return Promise.reject(error);
    }
    if (this.active) return this.active;
    const operation = this._run();
    this.active = operation.finally(() => { this.active = null; });
    return this.active;
  }

  async _run() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('clock must return UTC milliseconds');
    const cutoff = now - this.messageDays * DAY_MS;
    const runUid = maintenanceUid('cleanup');
    this.db.prepare(`
      INSERT INTO maintenance_runs(run_uid, operation, status, started_at)
      VALUES (?, 'CLEANUP', 'RUNNING', ?)
    `).run(runUid, now);

    try {
      const database = this._cleanupDatabase({ now, cutoff });
      const removedBlobFiles = [];
      const blobFileErrors = [];
      for (const blob of database.temporary.blobs) {
        try {
          if (await this.storage.remove(blob.storage_key)) removedBlobFiles.push(blob.storage_key);
        } catch (error) {
          blobFileErrors.push({ storageKey: blob.storage_key, code: error.code || 'REMOVE_FAILED' });
          this.logger.error?.(`Temporary attachment cleanup failed: ${error.message}`);
        }
      }
      const staging = await this._cleanupStaging(now - this.tempFileGraceMs);
      const result = { cutoff, ...database, removedBlobFiles, blobFileErrors, staging };
      const completedAt = Math.max(now, this.clock());
      this.db.prepare(`
        UPDATE maintenance_runs SET status='SUCCEEDED', completed_at=?, details_json=?
        WHERE run_uid=?
      `).run(completedAt, JSON.stringify(result), runUid);
      return result;
    } catch (error) {
      const completedAt = Math.max(now, this.clock());
      this.db.prepare(`
        UPDATE maintenance_runs SET status='FAILED', completed_at=?, error_code=?, error_message=?
        WHERE run_uid=?
      `).run(completedAt, error.code || 'CLEANUP_FAILED', String(error.message).slice(0, 2000), runUid);
      throw error;
    }
  }

  _cleanupDatabase({ now, cutoff }) {
    const transaction = this.db.transaction(() => {
      // Expiration is a state transition. Purging is deliberately delayed by the
      // configured grace and excludes confirmed sessions (issue evidence).
      const expiredSessions = this.db.prepare(`
        UPDATE reply_match_sessions
        SET status='EXPIRED', updated_at=@now
        WHERE status='PENDING' AND expires_at < @now
      `).run({ now }).changes;
      const purgeSessions = this.db.prepare(`
        SELECT id FROM reply_match_sessions s
        WHERE s.status IN ('EXPIRED', 'CANCELLED')
          AND s.updated_at < @sessionCutoff
          AND NOT EXISTS (SELECT 1 FROM issue_replies r WHERE r.session_id=s.id)
        ORDER BY id
      `).all({ sessionCutoff: now - this.replySessionGraceMs });
      const purgeIds = purgeSessions.map((row) => row.id);
      for (const batch of chunks(purgeIds)) {
        const ids = JSON.stringify(batch);
        this.db.prepare(`DELETE FROM reply_match_candidates
          WHERE session_id IN (SELECT value FROM json_each(?))`).run(ids);
        this.db.prepare(`DELETE FROM reply_match_sessions
          WHERE id IN (SELECT value FROM json_each(?))`).run(ids);
      }

      // Build the complete evidence closure once. Direct issue/event/reply/issue-
      // attachment sources are seeds; their quoted ancestors are evidence too.
      // Per the retention specification, archive and soft deletion affect issue
      // visibility only: evidence for archived/soft-deleted issues is permanent.
      this.db.exec('DROP TABLE IF EXISTS temp.retention_protected_messages');
      this.db.exec('DROP TABLE IF EXISTS temp.retention_evidence_links');
      this.db.exec(`
        CREATE TEMP TABLE retention_evidence_links(
          message_id INTEGER NOT NULL,
          issue_id INTEGER NOT NULL,
          chat_id INTEGER NOT NULL,
          PRIMARY KEY(message_id, issue_id)
        ) STRICT, WITHOUT ROWID;
        INSERT OR IGNORE INTO retention_evidence_links(message_id, issue_id, chat_id)
        WITH RECURSIVE links(message_id, issue_id, chat_id) AS (
          SELECT source_message_id, id, chat_id FROM issues WHERE source_message_id IS NOT NULL
          UNION SELECT source_message_id, issue_id, chat_id FROM issue_events
            WHERE source_message_id IS NOT NULL
          UNION SELECT r.source_message_id, r.current_issue_id, r.chat_id FROM issue_replies r
            WHERE r.source_message_id IS NOT NULL
          UNION SELECT message_id, issue_id, chat_id FROM attachments
            WHERE issue_id IS NOT NULL AND message_id IS NOT NULL
          UNION SELECT capture_message_id, issue_id, chat_id FROM attachments
            WHERE issue_id IS NOT NULL AND capture_message_id IS NOT NULL
          UNION
          SELECT m.quoted_message_id, links.issue_id, links.chat_id
          FROM messages m JOIN links ON links.message_id=m.id
          WHERE m.quoted_message_id IS NOT NULL
        ) SELECT message_id, issue_id, chat_id FROM links WHERE message_id IS NOT NULL;
        CREATE TEMP TABLE retention_protected_messages(id INTEGER PRIMARY KEY) STRICT;
        INSERT OR IGNORE INTO retention_protected_messages(id)
          SELECT DISTINCT message_id FROM retention_evidence_links;
      `);

      // If a source/quoted evidence message carried an attachment that was not
      // promoted during command handling, make the durable relationship explicit
      // before ordinary retention runs. Startup promotion later moves a temporary
      // storage key atomically; bytes are permanent immediately.
      const promotedEvidenceAttachments = this.db.prepare(`
        UPDATE attachments
        SET (issue_id, issue_chat_id)=(
              SELECT l.issue_id, i.chat_id
              FROM retention_evidence_links l JOIN issues i ON i.id=l.issue_id
              WHERE l.message_id IN (attachments.message_id, attachments.capture_message_id)
                AND l.chat_id=attachments.chat_id AND i.chat_id=attachments.chat_id
              ORDER BY l.issue_id LIMIT 1
            ),
            retention_class='ISSUE', updated_at=MAX(updated_at,@now)
        WHERE issue_id IS NULL AND deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM retention_evidence_links l JOIN issues i ON i.id=l.issue_id
            WHERE l.message_id IN (attachments.message_id, attachments.capture_message_id)
              AND l.chat_id=attachments.chat_id AND i.chat_id=attachments.chat_id
          )
      `).run({ now }).changes;
      this.db.prepare(`
        UPDATE attachment_blobs SET retention_class='ISSUE', updated_at=MAX(updated_at,@now)
        WHERE EXISTS (
          SELECT 1 FROM attachments a
          WHERE a.blob_sha256=attachment_blobs.sha256 AND a.issue_id IS NOT NULL
        )
      `).run({ now });

      const snapshotted = this.db.prepare(`
        INSERT OR IGNORE INTO retention_message_snapshots (
          message_id, message_uid, whatsapp_message_id, chat_id, sender_jid,
          sender_display_name, message_type, body_snapshot,
          quoted_whatsapp_message_id, quoted_body_snapshot, quoted_sender_jid,
          quoted_sent_at, quoted_media_json, sent_at, evidence_reasons_json,
          snapshotted_at
        )
        SELECT m.id, m.message_uid, m.whatsapp_message_id, m.chat_id, m.sender_jid,
          m.sender_display_name, m.message_type, m.body,
          m.quoted_whatsapp_message_id, m.quoted_body, m.quoted_sender_jid,
          m.quoted_sent_at, m.quoted_media_json, m.sent_at,
          json_array('ISSUE_SOURCE', 'AUDIT_OR_REPLY_EVIDENCE'), @now
        FROM messages m JOIN retention_protected_messages p ON p.id=m.id
        WHERE m.sent_at < @cutoff AND m.processing_status <> 'PROCESSING'
      `).run({ now, cutoff }).changes;
      const tombstoned = this.db.prepare(`
        UPDATE messages
        SET body=NULL, sender_display_name=NULL, is_tombstone=1,
            deleted_at=COALESCE(deleted_at, @now)
        WHERE id IN (SELECT id FROM retention_protected_messages)
          AND sent_at < @cutoff AND processing_status <> 'PROCESSING'
          AND is_tombstone=0
      `).run({ now, cutoff }).changes;

      // Attachment cleanup runs before ordinary-message deletion. It excludes
      // every active PROCESSING lease and every queue-admitted claim.
      const temporary = this.repositories.attachments.purgeExpiredTemporary(cutoff, now);

      // Exact boundary: only sent_at < cutoff is purged. PROCESSING and PENDING
      // rows are potentially active ingress data and are left for startup recovery.
      const ordinaryCandidates = this.db.prepare(`
        SELECT id FROM messages
        WHERE sent_at < @cutoff
          AND processing_status IN ('PROCESSED', 'FAILED')
          AND id NOT IN (SELECT id FROM retention_protected_messages)
          AND NOT EXISTS (
            SELECT 1 FROM attachments a
            WHERE (a.message_id=messages.id OR a.capture_message_id=messages.id)
              AND (a.processing_status='PROCESSING'
                OR a.processing_claim_id IS NOT NULL
                OR a.processing_lease_until IS NOT NULL)
          )
        ORDER BY id
      `).all({ cutoff });
      let ordinaryDeleted = 0;
      for (const batch of chunks(ordinaryCandidates.map((row) => row.id))) {
        ordinaryDeleted += this.db.prepare(`
          DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))
        `).run(JSON.stringify(batch)).changes;
      }
      this.db.exec('DROP TABLE temp.retention_protected_messages');
      this.db.exec('DROP TABLE temp.retention_evidence_links');
      return {
        expiredSessions,
        promotedEvidenceAttachments,
        purgedSessions: purgeIds,
        snapshotted,
        tombstoned,
        ordinaryDeleted,
        temporary,
      };
    });
    return transaction.immediate();
  }

  async _cleanupStaging(cutoff) {
    const root = path.resolve(this.storage.tempDir);
    const rootStat = await this.fs.promises.lstat(root);
    const rootReal = await this.fs.promises.realpath(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootReal !== root) {
      const error = new Error('Attachment staging root changed or became unsafe');
      error.code = 'UNSAFE_TEMP_ROOT';
      throw error;
    }
    const removed = [];
    const skipped = [];
    const removeEligible = async (candidate, relative, { allowDirectory = false } = {}) => {
      const stat = await this.fs.promises.lstat(candidate);
      if (stat.isDirectory()) {
        if (!allowDirectory) {
          skipped.push(relative);
          return;
        }
        // lstat and canonicalize every parent immediately before descent.
        // Symlink directories are unlinked as entries below and never traversed.
        if (await this.fs.promises.realpath(candidate) !== candidate) {
          const error = new Error(`Quarantine directory is not canonical: ${relative}`);
          error.code = 'UNSAFE_QUARANTINE_PATH';
          throw error;
        }
        for (const entry of await this.fs.promises.readdir(candidate, { withFileTypes: true })) {
          await removeEligible(path.join(candidate, entry.name), path.posix.join(relative, entry.name), {
            allowDirectory: true,
          });
        }
        return;
      }
      if (stat.mtimeMs >= cutoff) {
        skipped.push(relative);
        return;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        skipped.push(relative);
        return;
      }
      await this.fs.promises.unlink(candidate);
      removed.push(relative);
    };

    for (const entry of await this.fs.promises.readdir(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      if (entry.name.endsWith('.part')) {
        // A current stage file is protected by the exact mtime boundary. Symlink
        // stages are never followed and are left for explicit investigation.
        const stat = await this.fs.promises.lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs >= cutoff) {
          skipped.push(entry.name);
        } else {
          await this.fs.promises.unlink(candidate);
          removed.push(entry.name);
        }
        continue;
      }
      if (entry.name !== 'quarantine') continue;
      const quarantineStat = await this.fs.promises.lstat(candidate);
      if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()) {
        const error = new Error('Attachment quarantine path must be a real directory');
        error.code = 'UNSAFE_QUARANTINE_PATH';
        throw error;
      }
      for (const child of await this.fs.promises.readdir(candidate, { withFileTypes: true })) {
        await removeEligible(path.join(candidate, child.name), `quarantine/${child.name}`, {
          allowDirectory: true,
        });
      }
    }
    return { cutoff, removed, skipped };
  }

  stop() {
    // Cleanup has no cancellable destructive phase: stop only prevents scheduler
    // admission. The scheduler drains this active promise before DB shutdown.
    this.accepting = false;
  }

  async drain() {
    if (this.active) await this.active;
    return { drained: true };
  }
}

module.exports = { DAY_MS, RetentionService };
