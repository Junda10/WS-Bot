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
        detected_mime, size_bytes, sha256, storage_key, retention_class,
        processing_status, extracted_text, parse_error, created_at, updated_at
      ) VALUES (
        @attachmentUid, @idempotencyKey, @chatId, @messageId, @messageChatId,
        @sourceWhatsappMessageId, @issueId, @issueChatId, @displayName,
        @detectedMime, @sizeBytes, @sha256, @storageKey, @retentionClass,
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
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(
      requireInteger(id, 'id', { min: 1 })
    ) || null;
    return includeDeleted || !row || row.deleted_at === null ? row : null;
  }

  listForIssue(issueId) {
    return this.db.prepare(`
      SELECT * FROM attachments
      WHERE issue_id = ? AND deleted_at IS NULL ORDER BY id
    `).all(requireInteger(issueId, 'issueId', { min: 1 }));
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
      now: requireTimestamp(input.now, 'now'),
    };
    return immediate(this.db, () => {
      const existing = this.attemptByKey.get(values.idempotencyKey);
      if (existing) {
        assertIdempotent(existing, {
          attachment_id: values.attachmentId,
          operation: values.operation,
        }, ['attachment_id', 'operation'], 'attachment attempt');
        return { record: existing, created: false };
      }

      const allocated = this.db.prepare(`
        UPDATE attachments
        SET next_attempt_number = next_attempt_number + 1,
            processing_status = 'PROCESSING', updated_at = @now
        WHERE id = @attachmentId AND deleted_at IS NULL
        RETURNING next_attempt_number - 1 AS attempt_number
      `).get(values);
      if (!allocated) throw new Error('Attachment not found');
      const attempt = this.db.prepare(`
        INSERT INTO attachment_processing_attempts (
          attempt_uid, idempotency_key, attachment_id, attempt_number,
          operation, status, started_at, created_at
        ) VALUES (
          @attemptUid, @idempotencyKey, @attachmentId, @attemptNumber,
          @operation, 'STARTED', @now, @now
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
      const attachment = this.db.prepare(`
        UPDATE attachments
        SET processing_status = @attachmentStatus,
            extracted_text = COALESCE(@extractedText, extracted_text),
            parse_error = @parseError, updated_at = @now
        WHERE id = @attachmentId RETURNING *
      `).get({
        attachmentId: attempt.attachment_id,
        attachmentStatus,
        extractedText: input.extractedText == null ? null : String(input.extractedText),
        parseError: status === 'FAILED'
          ? (input.errorMessage == null ? 'Processing failed' : String(input.errorMessage))
          : null,
        now,
      });
      return { attempt, attachment };
    });
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
