'use strict';

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

const PROCESSING_STATUSES = new Set(['PENDING', 'PROCESSING', 'READY', 'FAILED', 'UNPARSED']);
const ATTEMPT_OPERATIONS = new Set(['DOWNLOAD', 'DETECT', 'EXTRACT', 'OCR', 'ARCHIVE']);

function hydrateBlob(row) {
  if (!row) return null;
  const result = { ...row };
  if (!result.storage_key && result.blob_storage_key) result.storage_key = result.blob_storage_key;
  delete result.blob_storage_key;
  return result;
}

function sha256(value) {
  if (value == null) return null;
  const normalized = requireString(value, 'sha256', { max: 64 }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new TypeError('sha256 must be 64 lowercase hex characters');
  return normalized;
}

function enumValue(value, name, values) {
  const normalized = requireString(value, name, { max: 30 }).toUpperCase();
  if (!values.has(normalized)) throw new TypeError(`Unsupported ${name}: ${value}`);
  return normalized;
}

class AttachmentRepository {
  constructor(db) {
    this.db = requireDatabase(db);
    this.byIdempotencyKey = db.prepare('SELECT * FROM attachments WHERE idempotency_key = ?');
    this.attemptByKey = db.prepare(
      'SELECT * FROM attachment_processing_attempts WHERE idempotency_key = ?'
    );
  }

  create(input) {
    const now = requireTimestamp(input.now, 'now');
    const issueId = input.issueId == null ? null : requireInteger(input.issueId, 'issueId', { min: 1 });
    const messageId = input.messageId == null ? null : requireInteger(input.messageId, 'messageId', { min: 1 });
    if (messageId === null && issueId === null) throw new TypeError('messageId or issueId is required');
    const message = messageId === null ? null : this.db.prepare(
      'SELECT id, chat_id, whatsapp_message_id FROM messages WHERE id = ?'
    ).get(messageId);
    const issue = issueId === null ? null : this.db.prepare(
      'SELECT id, chat_id FROM issues WHERE id = ?'
    ).get(issueId);
    if (messageId !== null && !message) throw new Error('Attachment message not found');
    if (issueId !== null && !issue) throw new Error('Attachment issue not found');
    const chatId = message?.chat_id ?? issue?.chat_id;
    if (message && issue && message.chat_id !== issue.chat_id) {
      throw new Error('Attachment message and issue belong to different chats');
    }
    if (input.chatId != null && requireInteger(input.chatId, 'chatId', { min: 1 }) !== chatId) {
      throw new Error('Attachment chat does not match its references');
    }
    const retentionClass = (input.retentionClass || (issueId ? 'ISSUE' : 'TEMPORARY')).toUpperCase();
    if (!['TEMPORARY', 'ISSUE'].includes(retentionClass)) throw new TypeError('Unsupported retentionClass');
    const values = {
      attachmentUid: uid(input.attachmentUid, 'attachmentUid'),
      idempotencyKey: requireString(input.idempotencyKey, 'idempotencyKey', { max: 500 }),
      chatId,
      messageId,
      messageChatId: message?.chat_id ?? null,
      sourceWhatsappMessageId: message?.whatsapp_message_id ?? null,
      issueId,
      issueChatId: issue?.chat_id ?? null,
      displayName: requireString(input.displayName, 'displayName', { max: 1000 }),
      declaredMime: optionalString(input.declaredMime, 'declaredMime', { max: 255 }),
      mediaWhatsappMessageId: optionalString(
        input.mediaWhatsappMessageId || message?.whatsapp_message_id,
        'mediaWhatsappMessageId',
        { max: 500 }
      ),
      detectedMime: optionalString(input.detectedMime, 'detectedMime', { max: 255 }),
      sizeBytes: requireInteger(input.sizeBytes, 'sizeBytes'),
      sha256: sha256(input.sha256),
      storageKey: optionalString(input.storageKey, 'storageKey', { max: 2000 }),
      retentionClass,
      processingStatus: enumValue(input.processingStatus || 'PENDING', 'processingStatus', PROCESSING_STATUSES),
      extractedText: input.extractedText == null ? null : String(input.extractedText),
      parseError: input.parseError == null ? null : String(input.parseError),
      now,
    };
    const created = this.db.prepare(`
      INSERT INTO attachments (
        attachment_uid, idempotency_key, chat_id, message_id, message_chat_id,
        source_whatsapp_message_id, issue_id, issue_chat_id, display_name,
        declared_mime, media_whatsapp_message_id, detected_mime, size_bytes, sha256,
        storage_key, retention_class, processing_status, extracted_text, parse_error,
        created_at, updated_at
      ) VALUES (
        @attachmentUid, @idempotencyKey, @chatId, @messageId, @messageChatId,
        @sourceWhatsappMessageId, @issueId, @issueChatId, @displayName,
        @declaredMime, @mediaWhatsappMessageId, @detectedMime, @sizeBytes, @sha256,
        @storageKey, @retentionClass,
        @processingStatus, @extractedText, @parseError, @now, @now
      ) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *
    `).get(values);
    if (created) return { record: created, created: true };

    const existing = this.byIdempotencyKey.get(values.idempotencyKey);
    assertIdempotent(existing, {
      message_id: values.messageId,
      issue_id: values.issueId,
      display_name: values.displayName,
      size_bytes: values.sizeBytes,
    }, ['message_id', 'issue_id', 'display_name', 'size_bytes'], 'attachment');
    return { record: existing, created: false };
  }

  findById(id, { includeDeleted = false } = {}) {
    const row = hydrateBlob(this.db.prepare(`
      SELECT a.*, b.storage_key AS blob_storage_key
      FROM attachments a LEFT JOIN attachment_blobs b ON b.sha256 = a.blob_sha256
      WHERE a.id = ?
    `).get(requireInteger(id, 'id', { min: 1 })) || null);
    return includeDeleted || !row || row.deleted_at === null ? row : null;
  }

  listForIssue(issueId) {
    return this.db.prepare(`
      SELECT a.*, b.storage_key AS blob_storage_key
      FROM attachments a LEFT JOIN attachment_blobs b ON b.sha256 = a.blob_sha256
      WHERE a.issue_id = ? AND a.deleted_at IS NULL ORDER BY a.id
    `).all(requireInteger(issueId, 'issueId', { min: 1 })).map(hydrateBlob);
  }

  listAttempts(attachmentId) {
    return this.db.prepare(`
      SELECT * FROM attachment_processing_attempts
      WHERE attachment_id = ? ORDER BY attempt_number
    `).all(requireInteger(attachmentId, 'attachmentId', { min: 1 }));
  }

  listRetryableForIssue(issueId, now = Date.now()) {
    return this.db.prepare(`
      SELECT a.*, b.storage_key AS blob_storage_key
      FROM attachments a LEFT JOIN attachment_blobs b ON b.sha256 = a.blob_sha256
      WHERE a.issue_id = ? AND a.deleted_at IS NULL AND a.retryable = 1
        AND (
          a.processing_status = 'FAILED'
          OR (a.processing_status = 'PENDING' AND a.processing_claim_id IS NULL)
          OR (a.processing_status = 'PROCESSING' AND a.processing_lease_until <= ?)
        )
      ORDER BY a.id
    `).all(
      requireInteger(issueId, 'issueId', { min: 1 }),
      requireTimestamp(now, 'now')
    ).map(hydrateBlob);
  }

  listBlobs() {
    return this.db.prepare(`
      SELECT b.*, r.live_reference_count, r.issue_reference_count
      FROM attachment_blobs b
      JOIN attachment_blob_live_references r ON r.sha256 = b.sha256
      ORDER BY b.sha256
    `).all();
  }

  blobReferenceCounts(sha) {
    return this.db.prepare(
      'SELECT * FROM attachment_blob_live_references WHERE sha256 = ?'
    ).get(sha256(sha)) || null;
  }

  findBlob(sha) {
    return this.db.prepare('SELECT * FROM attachment_blobs WHERE sha256 = ?').get(
      sha256(sha)
    ) || null;
  }

  recoverForStartup(now, activeClaimIds = []) {
    const timestamp = requireTimestamp(now, 'now');
    const activeClaims = [...new Set(activeClaimIds)].map((claimId) => (
      requireString(claimId, 'activeClaimId', { max: 200 })
    ));
    const values = { now: timestamp, activeClaimsJson: JSON.stringify(activeClaims) };
    return immediate(this.db, () => {
      // Ingress is held closed during initial recovery, so every claim not owned
      // by this AttachmentService instance belongs to a dead prior process. Do
      // not wait for its persisted lease: no old queue survives process death.
      this.db.prepare(`
        UPDATE attachment_processing_attempts
        SET status = 'FAILED', error_code = 'STALE_PROCESSING',
            error_message = 'Prior-process attachment work was reclaimed during recovery',
            retryable = 1, completed_at = MAX(@now, started_at)
        WHERE status = 'STARTED'
          AND (processing_claim_id IS NULL OR processing_claim_id NOT IN (
            SELECT value FROM json_each(@activeClaimsJson)
          ))
      `).run(values);
      this.db.prepare(`
        UPDATE attachments
        SET processing_status = 'PENDING', processing_claim_id = NULL,
            processing_lease_until = NULL, last_error_code = 'STALE_PROCESSING',
            parse_error = 'Interrupted attachment processing was recovered for retry',
            retryable = 1, updated_at = @now
        WHERE deleted_at IS NULL AND processing_status = 'PROCESSING'
          AND (processing_claim_id IS NULL OR processing_claim_id NOT IN (
            SELECT value FROM json_each(@activeClaimsJson)
          ))
      `).run(values);
      // A claimed PENDING row is durable queue admission, but queue membership
      // itself is process-local. Release every prior-process admission too.
      this.db.prepare(`
        UPDATE attachments
        SET processing_claim_id = NULL, processing_lease_until = NULL, updated_at = @now
        WHERE deleted_at IS NULL AND processing_status = 'PENDING'
          AND processing_claim_id IS NOT NULL
          AND processing_claim_id NOT IN (SELECT value FROM json_each(@activeClaimsJson))
      `).run(values);
      const recoverable = this.db.prepare(`
        SELECT a.*, b.storage_key AS blob_storage_key, c.jid AS chat_jid
        FROM attachments a
        JOIN chats c ON c.id = a.chat_id
        LEFT JOIN attachment_blobs b ON b.sha256 = a.blob_sha256
        WHERE a.deleted_at IS NULL
          AND a.processing_status IN ('PENDING', 'FAILED')
          AND a.retryable = 1 AND a.processing_claim_id IS NULL
          AND COALESCE(a.media_whatsapp_message_id,
          a.source_whatsapp_message_id) IS NOT NULL
        ORDER BY a.id
      `).all().map(hydrateBlob);
      const lease = this.db.prepare(`
        SELECT MIN(processing_lease_until) AS next_lease_until
        FROM attachments
        WHERE deleted_at IS NULL AND processing_status = 'PROCESSING'
          AND processing_claim_id IN (SELECT value FROM json_each(@activeClaimsJson))
      `).get(values);
      return { recoverable, nextLeaseUntil: lease.next_lease_until ?? null };
    });
  }

  claimForQueue(input) {
    const attachmentId = requireInteger(input.attachmentId, 'attachmentId', { min: 1 });
    const claimId = requireString(input.claimId, 'claimId', { max: 200 });
    const now = requireTimestamp(input.now, 'now');
    return immediate(this.db, () => {
      const current = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId);
      if (!current || current.deleted_at !== null || current.retryable !== 1) return null;
      const stale = current.processing_status === 'PROCESSING'
        && (current.processing_lease_until === null || current.processing_lease_until <= now);
      const eligible = current.processing_status === 'FAILED'
        || (current.processing_status === 'PENDING' && current.processing_claim_id === null)
        || stale;
      if (!eligible) return null;
      if (stale) {
        this.db.prepare(`
          UPDATE attachment_processing_attempts
          SET status = 'FAILED', error_code = 'STALE_PROCESSING',
              error_message = 'Attachment processing lease expired', retryable = 1,
              completed_at = MAX(@now, started_at)
          WHERE attachment_id = @attachmentId AND status = 'STARTED'
        `).run({ attachmentId, now });
      }
      return this.db.prepare(`
        UPDATE attachments
        SET processing_status = 'PENDING', processing_claim_id = @claimId,
            processing_lease_until = NULL, parse_error = NULL,
            last_error_code = NULL, updated_at = @now
        WHERE id = @attachmentId AND deleted_at IS NULL
        RETURNING *
      `).get({ attachmentId, claimId, now }) || null;
    });
  }

  markAdmissionFailed(input) {
    return this.db.prepare(`
      UPDATE attachments
      SET processing_status = 'FAILED', processing_claim_id = NULL,
          processing_lease_until = NULL, parse_error = @message,
          last_error_code = @code, retryable = @retryable, updated_at = @now
      WHERE id = @attachmentId AND processing_status = 'PENDING'
        AND processing_claim_id = @claimId
      RETURNING *
    `).get({
      attachmentId: requireInteger(input.attachmentId, 'attachmentId', { min: 1 }),
      claimId: requireString(input.claimId, 'claimId', { max: 200 }),
      code: requireString(input.code, 'code', { max: 100 }),
      message: requireString(input.message, 'message', { max: 2000 }),
      retryable: input.retryable === false ? 0 : 1,
      now: requireTimestamp(input.now, 'now'),
    }) || null;
  }

  markCaptureFailed(input) {
    return this.db.prepare(`
      UPDATE attachments
      SET processing_status = 'FAILED', parse_error = @message,
          last_error_code = @code, retryable = @retryable, updated_at = @now
      WHERE id = @attachmentId AND deleted_at IS NULL
        AND processing_status = 'PENDING' AND processing_claim_id IS NULL
      RETURNING *
    `).get({
      attachmentId: requireInteger(input.attachmentId, 'attachmentId', { min: 1 }),
      code: requireString(input.code, 'code', { max: 100 }),
      message: requireString(input.message, 'message', { max: 2000 }),
      retryable: input.retryable === false ? 0 : 1,
      now: requireTimestamp(input.now, 'now'),
    }) || null;
  }

  setPending(id, now) {
    return this.db.prepare(`
      UPDATE attachments
      SET processing_status = 'PENDING', parse_error = NULL,
          last_error_code = NULL, processing_claim_id = NULL,
          processing_lease_until = NULL, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND retryable = 1
      RETURNING *
    `).get(
      requireTimestamp(now, 'now'),
      requireInteger(id, 'id', { min: 1 })
    ) || null;
  }

  linkToIssue(id, issueId, now) {
    const attachmentId = requireInteger(id, 'id', { min: 1 });
    const targetIssueId = requireInteger(issueId, 'issueId', { min: 1 });
    const attachment = this.db.prepare('SELECT chat_id FROM attachments WHERE id = ?').get(attachmentId);
    const issue = this.db.prepare('SELECT chat_id FROM issues WHERE id = ?').get(targetIssueId);
    if (!attachment) return null;
    if (!issue) throw new Error('Attachment issue not found');
    if (attachment.chat_id !== issue.chat_id) throw new Error('Attachment issue belongs to a different chat');
    return this.db.prepare(`
      UPDATE attachments
      SET issue_id = ?, issue_chat_id = ?, retention_class = 'ISSUE', updated_at = ?
      WHERE id = ? AND deleted_at IS NULL RETURNING *
    `).get(
      targetIssueId,
      issue.chat_id,
      requireTimestamp(now, 'now'),
      attachmentId
    ) || null;
  }

  startAttempt(input) {
    const values = {
      attemptUid: uid(input.attemptUid, 'attemptUid'),
      idempotencyKey: requireString(input.idempotencyKey, 'idempotencyKey', { max: 500 }),
      attachmentId: requireInteger(input.attachmentId, 'attachmentId', { min: 1 }),
      operation: enumValue(input.operation, 'operation', ATTEMPT_OPERATIONS),
      claimId: input.claimId == null
        ? `direct:${requireString(input.idempotencyKey, 'idempotencyKey', { max: 500 })}`
        : requireString(input.claimId, 'claimId', { max: 200 }),
      directClaim: input.claimId == null,
      now: requireTimestamp(input.now, 'now'),
      leaseUntil: input.leaseUntil == null
        ? requireTimestamp(input.now, 'now') + 10 * 60 * 1000
        : requireTimestamp(input.leaseUntil, 'leaseUntil'),
    };
    if (values.leaseUntil <= values.now) throw new TypeError('leaseUntil must be after now');
    return immediate(this.db, () => {
      const existing = this.attemptByKey.get(values.idempotencyKey);
      if (existing) {
        assertIdempotent(existing, {
          attachment_id: values.attachmentId,
          operation: values.operation,
        }, ['attachment_id', 'operation'], 'attachment attempt');
        return { record: existing, created: false };
      }

      if (values.directClaim) {
        this.db.prepare(`
          UPDATE attachments
          SET processing_status = 'PENDING', processing_claim_id = @claimId,
              processing_lease_until = NULL, retryable = 1, updated_at = @now
          WHERE id = @attachmentId AND deleted_at IS NULL
            AND processing_status <> 'PROCESSING'
        `).run(values);
      }
      const allocated = this.db.prepare(`
        UPDATE attachments
        SET next_attempt_number = next_attempt_number + 1,
            processing_status = 'PROCESSING', parse_error = NULL,
            last_error_code = NULL, processing_lease_until = @leaseUntil,
            updated_at = @now
        WHERE id = @attachmentId AND deleted_at IS NULL
          AND processing_status = 'PENDING' AND processing_claim_id = @claimId
        RETURNING next_attempt_number - 1 AS attempt_number
      `).get(values);
      if (!allocated) throw new Error('Attachment queue claim is no longer active');
      const attempt = this.db.prepare(`
        INSERT INTO attachment_processing_attempts (
          attempt_uid, idempotency_key, attachment_id, attempt_number,
          operation, status, processing_claim_id, started_at, created_at
        ) VALUES (
          @attemptUid, @idempotencyKey, @attachmentId, @attemptNumber,
          @operation, 'STARTED', @claimId, @now, @now
        ) RETURNING *
      `).get({ ...values, attemptNumber: allocated.attempt_number });
      return { record: attempt, created: true };
    });
  }

  completeAttempt(input) {
    const attemptId = requireInteger(input.attemptId, 'attemptId', { min: 1 });
    const status = enumValue(input.status, 'status', new Set(['SUCCEEDED', 'FAILED']));
    const now = requireTimestamp(input.now, 'now');
    return immediate(this.db, () => {
      const attempt = this.db.prepare(`
        UPDATE attachment_processing_attempts
        SET status = @status, error_code = @errorCode, error_message = @errorMessage,
            completed_at = @now
        WHERE id = @attemptId AND status = 'STARTED'
        RETURNING *
      `).get({
        attemptId,
        status,
        errorCode: optionalString(input.errorCode, 'errorCode', { max: 100 }),
        errorMessage: input.errorMessage == null ? null : String(input.errorMessage),
        now,
      });
      if (!attempt) throw new Error('Attachment attempt is not active');

      const attachmentStatus = status === 'SUCCEEDED'
        ? enumValue(input.attachmentStatus || 'READY', 'attachmentStatus', PROCESSING_STATUSES)
        : 'FAILED';
      const retryable = status === 'FAILED' ? (input.retryable === false ? 0 : 1) : 0;
      this.db.prepare(`
        UPDATE attachment_processing_attempts
        SET retryable = @retryable, metadata_json = @metadataJson
        WHERE id = @attemptId
      `).run({
        attemptId,
        retryable,
        metadataJson: input.metadata == null ? null : JSON.stringify(input.metadata),
      });
      const attachment = this.db.prepare(`
        UPDATE attachments
        SET processing_status = @attachmentStatus,
            extracted_text = COALESCE(@extractedText, extracted_text),
            parse_error = @parseError, last_error_code = @errorCode,
            retryable = @retryable, processing_claim_id = NULL,
            processing_lease_until = NULL, updated_at = @now
        WHERE id = @attachmentId AND processing_claim_id = @claimId RETURNING *
      `).get({
        attachmentId: attempt.attachment_id,
        claimId: attempt.processing_claim_id,
        attachmentStatus,
        extractedText: input.extractedText == null ? null : String(input.extractedText),
        parseError: status === 'FAILED'
          ? (input.errorMessage == null ? 'Processing failed' : String(input.errorMessage))
          : null,
        errorCode: status === 'FAILED'
          ? (optionalString(input.errorCode, 'errorCode', { max: 100 }) || 'PROCESSING_FAILED')
          : null,
        retryable,
        now,
      });
      if (!attachment) throw new Error('Attachment processing claim was lost');
      return { attempt: this.db.prepare(
        'SELECT * FROM attachment_processing_attempts WHERE id = ?'
      ).get(attemptId), attachment };
    });
  }

  finalizeProcessingSuccess(input) {
    const values = {
      attemptId: requireInteger(input.attemptId, 'attemptId', { min: 1 }),
      attachmentId: requireInteger(input.attachmentId, 'attachmentId', { min: 1 }),
      sha256: sha256(input.sha256),
      storageKey: requireString(input.storageKey, 'storageKey', { max: 2000 }),
      sizeBytes: requireInteger(input.sizeBytes, 'sizeBytes'),
      detectedMime: requireString(input.detectedMime, 'detectedMime', { max: 255 }),
      detectedExtension: requireString(input.detectedExtension, 'detectedExtension', { max: 16 }),
      retentionClass: requireString(input.retentionClass || 'TEMPORARY', 'retentionClass', { max: 20 }).toUpperCase(),
      displayName: requireString(input.displayName, 'displayName', { max: 1000 }),
      metadataJson: input.metadata == null ? null : JSON.stringify(input.metadata),
      now: requireTimestamp(input.now, 'now'),
    };
    if (!['TEMPORARY', 'ISSUE'].includes(values.retentionClass)) throw new TypeError('Unsupported retentionClass');
    return immediate(this.db, () => {
      const attempt = this.db.prepare(`
        SELECT * FROM attachment_processing_attempts
        WHERE id = @attemptId AND attachment_id = @attachmentId AND status = 'STARTED'
      `).get(values);
      if (!attempt) throw new Error('Attachment attempt is not active');
      const attachment = this.db.prepare(`
        SELECT * FROM attachments WHERE id = @attachmentId AND deleted_at IS NULL
          AND processing_status = 'PROCESSING' AND processing_claim_id = @claimId
      `).get({ ...values, claimId: attempt.processing_claim_id });
      if (!attachment) throw new Error('Attachment processing claim was lost');

      const inserted = this.db.prepare(`
        INSERT INTO attachment_blobs (
          sha256, storage_key, size_bytes, retention_class, created_at, updated_at
        ) VALUES (
          @sha256, @storageKey, @sizeBytes, @retentionClass, @now, @now
        ) ON CONFLICT(sha256) DO NOTHING
      `).run(values).changes === 1;
      const blob = this.db.prepare('SELECT * FROM attachment_blobs WHERE sha256 = ?').get(values.sha256);
      if (!blob || blob.size_bytes !== values.sizeBytes) {
        throw new Error('Attachment blob byte metadata conflicts with content hash');
      }
      const canonical = this.db.prepare(`
        SELECT id FROM attachments
        WHERE blob_sha256 = @sha256 AND deleted_at IS NULL AND id <> @attachmentId
        ORDER BY id LIMIT 1
      `).get(values);
      const completedAttachment = this.db.prepare(`
        UPDATE attachments
        SET display_name = @displayName, detected_mime = @detectedMime,
            detected_extension = @detectedExtension, size_bytes = @sizeBytes,
            sha256 = @sha256, blob_sha256 = @sha256, storage_key = NULL,
            duplicate_of_attachment_id = @duplicateId,
            downloaded_at = @now, archived_at = @now,
            processing_status = 'UNPARSED', parse_error = NULL,
            last_error_code = NULL, retryable = 0,
            processing_claim_id = NULL, processing_lease_until = NULL,
            updated_at = @now
        WHERE id = @attachmentId AND processing_claim_id = @claimId
        RETURNING *
      `).get({
        ...values,
        claimId: attempt.processing_claim_id,
        duplicateId: canonical?.id ?? null,
      });
      if (!completedAttachment) throw new Error('Attachment processing claim was lost');
      this.db.prepare(`
        UPDATE attachment_processing_attempts
        SET status = 'SUCCEEDED', retryable = 0, metadata_json = @metadataJson,
            error_code = NULL, error_message = NULL, completed_at = @now
        WHERE id = @attemptId AND status = 'STARTED'
      `).run(values);
      return {
        attachment: completedAttachment,
        attempt: this.db.prepare(
          'SELECT * FROM attachment_processing_attempts WHERE id = ?'
        ).get(values.attemptId),
        blob: this.db.prepare('SELECT * FROM attachment_blobs WHERE sha256 = ?').get(values.sha256),
        deduplicated: !inserted,
        orphanStorageKey: inserted ? null : values.storageKey,
      };
    });
  }

  finalizeArchive(input) {
    const values = {
      attachmentId: requireInteger(input.attachmentId, 'attachmentId', { min: 1 }),
      sha256: sha256(input.sha256),
      storageKey: requireString(input.storageKey, 'storageKey', { max: 2000 }),
      sizeBytes: requireInteger(input.sizeBytes, 'sizeBytes'),
      detectedMime: requireString(input.detectedMime, 'detectedMime', { max: 255 }),
      detectedExtension: requireString(input.detectedExtension, 'detectedExtension', { max: 16 }),
      retentionClass: requireString(input.retentionClass || 'TEMPORARY', 'retentionClass', { max: 20 }).toUpperCase(),
      displayName: requireString(input.displayName, 'displayName', { max: 1000 }),
      now: requireTimestamp(input.now, 'now'),
    };
    if (!['TEMPORARY', 'ISSUE'].includes(values.retentionClass)) {
      throw new TypeError('Unsupported retentionClass');
    }
    return immediate(this.db, () => {
      this.db.prepare(`
        INSERT INTO attachment_blobs (
          sha256, storage_key, size_bytes, retention_class, created_at, updated_at
        ) VALUES (
          @sha256, @storageKey, @sizeBytes, @retentionClass, @now, @now
        )
      `).run(values);
      return this.db.prepare(`
        UPDATE attachments
        SET display_name = @displayName, detected_mime = @detectedMime,
            detected_extension = @detectedExtension, size_bytes = @sizeBytes,
            sha256 = @sha256, blob_sha256 = @sha256, storage_key = NULL,
            duplicate_of_attachment_id = NULL, downloaded_at = @now,
            archived_at = @now, updated_at = @now
        WHERE id = @attachmentId AND deleted_at IS NULL RETURNING *
      `).get(values);
    });
  }

  finalizeDuplicate(input) {
    const values = {
      attachmentId: requireInteger(input.attachmentId, 'attachmentId', { min: 1 }),
      sha256: sha256(input.sha256),
      duplicateOfAttachmentId: input.duplicateOfAttachmentId == null
        ? null
        : requireInteger(input.duplicateOfAttachmentId, 'duplicateOfAttachmentId', { min: 1 }),
      sizeBytes: requireInteger(input.sizeBytes, 'sizeBytes'),
      detectedMime: requireString(input.detectedMime, 'detectedMime', { max: 255 }),
      detectedExtension: requireString(input.detectedExtension, 'detectedExtension', { max: 16 }),
      displayName: requireString(input.displayName, 'displayName', { max: 1000 }),
      now: requireTimestamp(input.now, 'now'),
    };
    if (!this.findBlob(values.sha256)) throw new Error('Attachment blob not found for dedupe');
    return this.db.prepare(`
      UPDATE attachments
      SET display_name = @displayName, detected_mime = @detectedMime,
          detected_extension = @detectedExtension, size_bytes = @sizeBytes,
          sha256 = @sha256, blob_sha256 = @sha256, storage_key = NULL,
          duplicate_of_attachment_id = @duplicateOfAttachmentId,
          downloaded_at = @now, archived_at = @now, updated_at = @now
      WHERE id = @attachmentId AND deleted_at IS NULL RETURNING *
    `).get(values) || null;
  }

  findAttachmentForBlob(sha, excludingId = null) {
    return this.db.prepare(`
      SELECT id FROM attachments
      WHERE blob_sha256 = ? AND deleted_at IS NULL AND (? IS NULL OR id <> ?)
      ORDER BY id LIMIT 1
    `).get(sha256(sha), excludingId, excludingId) || null;
  }

  beginBlobPromotion(input) {
    const values = {
      attachmentId: requireInteger(input.attachmentId, 'attachmentId', { min: 1 }),
      issueId: requireInteger(input.issueId, 'issueId', { min: 1 }),
      targetKey: requireString(input.targetKey, 'targetKey', { max: 2000 }),
      now: requireTimestamp(input.now, 'now'),
    };
    return immediate(this.db, () => {
      const attachment = this.db.prepare(`
        SELECT * FROM attachments WHERE id = @attachmentId AND deleted_at IS NULL
      `).get(values);
      const issue = this.db.prepare('SELECT * FROM issues WHERE id = @issueId').get(values);
      if (!attachment || !issue || attachment.chat_id !== issue.chat_id) {
        throw new Error('Attachment promotion references are unavailable or cross-chat');
      }
      if (!attachment.blob_sha256) throw new Error('Attachment blob is unavailable for promotion');
      const blob = this.db.prepare(
        'SELECT * FROM attachment_blobs WHERE sha256 = ?'
      ).get(attachment.blob_sha256);
      if (!blob) throw new Error('Attachment blob is unavailable for promotion');

      this.db.prepare(`
        UPDATE attachments
        SET issue_id = @issueId, issue_chat_id = @issueChatId,
            retention_class = 'ISSUE', updated_at = @now
        WHERE id = @attachmentId
      `).run({ ...values, issueChatId: issue.chat_id });
      if (blob.promotion_target_key && blob.promotion_target_key !== values.targetKey) {
        // The first promotion intent owns the canonical destination. All later
        // issue links share that one blob and reconcile the existing intent.
        values.targetKey = blob.promotion_target_key;
      }
      this.db.prepare(`
        UPDATE attachment_blobs
        SET retention_class = 'ISSUE',
            promotion_target_key = COALESCE(promotion_target_key, @targetKey),
            promotion_issue_id = COALESCE(promotion_issue_id, @issueId),
            promotion_started_at = COALESCE(promotion_started_at, @now),
            updated_at = @now
        WHERE sha256 = @sha256
      `).run({ ...values, sha256: attachment.blob_sha256 });
      return {
        attachment: this.findById(values.attachmentId),
        blob: this.findBlob(attachment.blob_sha256),
      };
    });
  }

  completeBlobPromotion(input) {
    const values = {
      sha256: sha256(input.sha256),
      targetKey: requireString(input.targetKey, 'targetKey', { max: 2000 }),
      now: requireTimestamp(input.now, 'now'),
    };
    return immediate(this.db, () => {
      const updated = this.db.prepare(`
        UPDATE attachment_blobs
        SET storage_key = @targetKey, retention_class = 'ISSUE',
            promotion_target_key = NULL, promotion_issue_id = NULL,
            promotion_started_at = NULL, updated_at = @now
        WHERE sha256 = @sha256 AND promotion_target_key = @targetKey
        RETURNING *
      `).get(values);
      if (updated) return updated;
      const current = this.findBlob(values.sha256);
      if (current?.storage_key === values.targetKey
          && current.promotion_target_key === null) return current;
      throw new Error('Attachment blob promotion intent was lost');
    });
  }

  listPendingBlobPromotions() {
    return this.db.prepare(`
      SELECT * FROM attachment_blobs
      WHERE promotion_target_key IS NOT NULL
      ORDER BY promotion_started_at, sha256
    `).all();
  }

  updateBlobStorage(input) {
    const values = {
      sha256: sha256(input.sha256),
      storageKey: requireString(input.storageKey, 'storageKey', { max: 2000 }),
      retentionClass: requireString(input.retentionClass, 'retentionClass', { max: 20 }).toUpperCase(),
      now: requireTimestamp(input.now, 'now'),
    };
    if (!['TEMPORARY', 'ISSUE'].includes(values.retentionClass)) throw new TypeError('Unsupported retentionClass');
    return this.db.prepare(`
      UPDATE attachment_blobs
      SET storage_key = @storageKey, retention_class = @retentionClass, updated_at = @now
      WHERE sha256 = @sha256 RETURNING *
    `).get(values) || null;
  }

  reconcileMissingBlob(sha, now) {
    const hash = sha256(sha);
    const timestamp = requireTimestamp(now, 'now');
    return immediate(this.db, () => {
      const blob = this.db.prepare('SELECT * FROM attachment_blobs WHERE sha256 = ?').get(hash);
      if (!blob) return { blob: null, attachmentIds: [] };
      const attachments = this.db.prepare(`
        SELECT id, media_whatsapp_message_id, source_whatsapp_message_id
        FROM attachments WHERE blob_sha256 = ? AND deleted_at IS NULL
      `).all(hash);
      this.db.prepare(`
        UPDATE attachments
        SET blob_sha256 = NULL, sha256 = NULL, duplicate_of_attachment_id = NULL,
            processing_status = 'FAILED', last_error_code = 'ARCHIVE_MISSING',
            parse_error = 'Archived blob is missing; source media may be retried',
            retryable = CASE WHEN COALESCE(media_whatsapp_message_id,
              source_whatsapp_message_id) IS NULL THEN 0 ELSE 1 END,
            processing_claim_id = NULL, processing_lease_until = NULL,
            updated_at = ?
        WHERE blob_sha256 = ?
      `).run(timestamp, hash);
      this.db.prepare('DELETE FROM attachment_blobs WHERE sha256 = ?').run(hash);
      return { blob, attachmentIds: attachments.map((row) => row.id) };
    });
  }

  deleteBlobIfUnreferenced(sha) {
    const hash = sha256(sha);
    return immediate(this.db, () => {
      const blob = this.db.prepare('SELECT * FROM attachment_blobs WHERE sha256 = ?').get(hash);
      if (!blob) return null;
      const refs = this.db.prepare(`
        SELECT COUNT(*) AS count FROM attachments WHERE blob_sha256 = ?
      `).get(hash).count;
      if (refs !== 0) return null;
      this.db.prepare('DELETE FROM attachment_blobs WHERE sha256 = ?').run(hash);
      return blob;
    });
  }

  purgeTemporaryBlob(sha) {
    const hash = sha256(sha);
    return immediate(this.db, () => {
      const blob = this.findBlob(hash);
      if (!blob) return null;
      if (blob.retention_class !== 'TEMPORARY' || blob.promotion_target_key !== null) return null;
      const references = this.db.prepare(`
        SELECT id, issue_id, retention_class, deleted_at
        FROM attachments WHERE blob_sha256 = ? ORDER BY id
      `).all(hash);
      if (references.length === 0) {
        this.db.prepare('DELETE FROM attachment_blobs WHERE sha256 = ?').run(hash);
        return { blob, attachmentIds: [] };
      }
      const eligible = references.every((row) => row.deleted_at !== null
        && row.issue_id === null && row.retention_class === 'TEMPORARY');
      if (!eligible) return null;
      const ids = references.map((row) => row.id);
      const idsJson = JSON.stringify(ids);
      // Processing attempts are lifecycle history for temporary rows only; they
      // are purged together. Issue evidence/history can never enter this branch.
      this.db.prepare(`
        DELETE FROM attachment_processing_attempts
        WHERE attachment_id IN (SELECT value FROM json_each(?))
      `).run(idsJson);
      this.db.prepare(`
        UPDATE attachments SET duplicate_of_attachment_id = NULL
        WHERE duplicate_of_attachment_id IN (SELECT value FROM json_each(?))
      `).run(idsJson);
      this.db.prepare(`
        DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?))
      `).run(idsJson);
      const remaining = this.db.prepare(
        'SELECT COUNT(*) AS count FROM attachments WHERE blob_sha256 = ?'
      ).get(hash).count;
      if (remaining !== 0) throw new Error('Temporary attachment purge left blob references');
      this.db.prepare('DELETE FROM attachment_blobs WHERE sha256 = ?').run(hash);
      return { blob, attachmentIds: ids };
    });
  }

  recomputeBlobRetention(sha, now) {
    const hash = sha256(sha);
    const timestamp = requireTimestamp(now, 'now');
    return this.db.prepare(`
      UPDATE attachment_blobs
      SET retention_class = CASE WHEN EXISTS (
        SELECT 1 FROM attachments a
        WHERE a.blob_sha256 = @sha256
          AND (a.issue_id IS NOT NULL OR a.retention_class = 'ISSUE')
      ) THEN 'ISSUE' ELSE 'TEMPORARY' END,
      updated_at = @now
      WHERE sha256 = @sha256 RETURNING *
    `).get({ sha256: hash, now: timestamp }) || null;
  }

  softDelete(id, now) {
    const timestamp = requireTimestamp(now, 'now');
    return this.db.prepare(`
      UPDATE attachments SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
      WHERE id = ? RETURNING *
    `).get(timestamp, timestamp, requireInteger(id, 'id', { min: 1 })) || null;
  }
}

module.exports = { ATTEMPT_OPERATIONS, AttachmentRepository, PROCESSING_STATUSES };
