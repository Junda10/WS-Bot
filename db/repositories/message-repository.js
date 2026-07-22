'use strict';

const crypto = require('crypto');
const {
  assertIdempotent,
  booleanInteger,
  jsonValue,
  optionalString,
  requireDatabase,
  requireInteger,
  requireString,
  requireTimestamp,
  uid,
} = require('./shared');

const MESSAGE_TYPES = new Set(['TEXT', 'MEDIA', 'SYSTEM']);

class MessageRepository {
  constructor(db) {
    this.db = requireDatabase(db);
    this.byWhatsappId = db.prepare('SELECT * FROM messages WHERE whatsapp_message_id = ?');
    this.claimStatement = db.prepare(`
      UPDATE messages
      SET processing_status = 'PROCESSING',
          processing_attempt_count = processing_attempt_count + 1,
          processing_claim_id = @claimId,
          processing_started_at = @now,
          processing_lease_expires_at = @leaseExpiresAt,
          processing_completed_at = NULL,
          processing_last_error = NULL
      WHERE id = @id
        AND (
          processing_status IN ('PENDING', 'FAILED')
          OR (processing_status = 'PROCESSING' AND processing_lease_expires_at <= @now)
        )
      RETURNING *
    `);
  }

  create(input) {
    const messageType = (input.messageType || 'TEXT').toUpperCase();
    if (!MESSAGE_TYPES.has(messageType)) throw new TypeError(`Unsupported messageType: ${messageType}`);
    const quotedBody = input.quotedBody === undefined || input.quotedBody === null
      ? null
      : String(input.quotedBody);
    const values = {
      messageUid: uid(input.messageUid, 'messageUid'),
      whatsappMessageId: requireString(input.whatsappMessageId, 'whatsappMessageId', { max: 500 }),
      chatId: requireInteger(input.chatId, 'chatId', { min: 1 }),
      senderJid: requireString(input.senderJid, 'senderJid', { max: 200 }),
      senderDisplayName: optionalString(
        input.senderDisplayName,
        'senderDisplayName',
        { max: 200 }
      ),
      messageType,
      body: input.body === undefined || input.body === null ? null : String(input.body),
      quotedMessageId: input.quotedMessageId == null
        ? null
        : requireInteger(input.quotedMessageId, 'quotedMessageId', { min: 1 }),
      quotedMessageChatId: null,
      quotedWhatsappMessageId: optionalString(
        input.quotedWhatsappMessageId,
        'quotedWhatsappMessageId',
        { max: 500 }
      ),
      quotedBody,
      quotedSenderJid: optionalString(input.quotedSenderJid, 'quotedSenderJid', { max: 200 }),
      quotedSentAt: input.quotedSentAt == null
        ? null
        : requireTimestamp(input.quotedSentAt, 'quotedSentAt'),
      quotedMediaJson: jsonValue(input.quotedMedia, 'quotedMedia'),
      sentAt: requireTimestamp(input.sentAt, 'sentAt'),
      receivedAt: requireTimestamp(input.receivedAt, 'receivedAt'),
      isCommand: booleanInteger(input.isCommand),
      createdAt: requireTimestamp(input.createdAt ?? input.receivedAt, 'createdAt'),
    };
    if (values.receivedAt < values.sentAt) throw new RangeError('receivedAt must be >= sentAt');
    if (values.quotedMessageId !== null) {
      const quoted = this.db.prepare(
        'SELECT chat_id, whatsapp_message_id FROM messages WHERE id = ?'
      ).get(values.quotedMessageId);
      if (!quoted) throw new Error('Quoted message not found');
      if (quoted.chat_id !== values.chatId) throw new Error('Quoted message belongs to a different chat');
      if (values.quotedWhatsappMessageId != null
          && values.quotedWhatsappMessageId !== quoted.whatsapp_message_id) {
        throw new Error('Quoted message WhatsApp snapshot does not match');
      }
      values.quotedMessageChatId = quoted.chat_id;
      values.quotedWhatsappMessageId = quoted.whatsapp_message_id;
    }

    const created = this.db.prepare(`
      INSERT INTO messages (
        message_uid, whatsapp_message_id, chat_id, sender_jid, sender_display_name,
        message_type, body, quoted_message_id, quoted_message_chat_id,
        quoted_whatsapp_message_id, quoted_body, quoted_sender_jid, quoted_sent_at,
        quoted_media_json, sent_at, received_at, is_command, created_at
      ) VALUES (
        @messageUid, @whatsappMessageId, @chatId, @senderJid, @senderDisplayName,
        @messageType, @body, @quotedMessageId, @quotedMessageChatId,
        @quotedWhatsappMessageId, @quotedBody, @quotedSenderJid, @quotedSentAt,
        @quotedMediaJson, @sentAt, @receivedAt, @isCommand, @createdAt
      ) ON CONFLICT(whatsapp_message_id) DO NOTHING RETURNING *
    `).get(values);
    if (created) return { record: created, created: true };

    const existing = this.byWhatsappId.get(values.whatsappMessageId);
    assertIdempotent(existing, {
      chat_id: values.chatId,
      sender_jid: values.senderJid,
      sent_at: values.sentAt,
    }, ['chat_id', 'sender_jid', 'sent_at'], 'message');
    return { record: existing, created: false };
  }

  findByWhatsappId(whatsappMessageId, { includeTombstone = true } = {}) {
    const row = this.byWhatsappId.get(
      requireString(whatsappMessageId, 'whatsappMessageId', { max: 500 })
    ) || null;
    return includeTombstone || !row || row.is_tombstone === 0 ? row : null;
  }

  findById(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(
      requireInteger(id, 'id', { min: 1 })
    ) || null;
  }

  listRecent(chatId, options = {}) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const limit = requireInteger(options.limit ?? 200, 'limit', { min: 1, max: 1000 });
    const after = requireTimestamp(options.after ?? 0, 'after');
    const afterId = requireInteger(options.afterId ?? 0, 'afterId');
    const includeCommands = options.includeCommands !== false;
    const includeTombstones = options.includeTombstones === true;
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE chat_id = ? AND sent_at >= ? AND id > ?
          AND body IS NOT NULL
          -- SQLite trim(X) removes ASCII spaces only. Supply the complete
          -- Unicode White_Space set so blank rows cannot consume the LIMIT.
          AND length(trim(body, char(
            9, 10, 11, 12, 13, 32, 133, 160, 5760,
            8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
            8232, 8233, 8239, 8287, 12288
          ))) > 0
          ${includeCommands ? '' : 'AND is_command = 0'}
          ${includeTombstones ? '' : 'AND is_tombstone = 0'}
        ORDER BY sent_at DESC, id DESC
        LIMIT ?
      ) ORDER BY sent_at, id
    `).all(id, after, afterId, limit);
  }

  highWatermark(chatId) {
    return this.db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE chat_id = ?'
    ).get(requireInteger(chatId, 'chatId', { min: 1 })).id;
  }

  createProcessed(input, options = {}) {
    const completedAt = requireTimestamp(
      options.completedAt ?? input.receivedAt,
      'completedAt'
    );
    const transaction = this.db.transaction(() => {
      const created = this.create(input);
      if (!created.created) return created;
      const claimed = this.claimProcessing(created.record.id, {
        claimId: options.claimId || `completed:${created.record.message_uid}`,
        now: completedAt,
        leaseMs: 1,
      });
      if (!claimed) throw new Error('Could not claim newly created processed message');
      const record = this.markProcessed(created.record.id, claimed.processing_claim_id, completedAt);
      if (!record) throw new Error('Could not complete newly created processed message');
      return { record, created: true };
    });
    return transaction();
  }

  recoverProcessingForStartup(chatId, now) {
    requireTimestamp(now, 'now');
    return this.db.prepare(`
      UPDATE messages
      SET processing_status = 'FAILED', processing_claim_id = NULL,
          processing_lease_expires_at = NULL, processing_completed_at = NULL,
          processing_last_error = 'Prior-process message route was reclaimed during startup recovery'
      WHERE chat_id = @chatId AND processing_status = 'PROCESSING'
      RETURNING *
    `).all({ chatId: requireInteger(chatId, 'chatId', { min: 1 }) });
  }

  claimProcessing(id, options = {}) {
    const messageId = requireInteger(id, 'id', { min: 1 });
    const now = requireTimestamp(options.now, 'now');
    const leaseMs = requireInteger(options.leaseMs, 'leaseMs', { min: 1 });
    if (now + leaseMs > Number.MAX_SAFE_INTEGER) throw new RangeError('processing lease is too large');
    const claimId = optionalString(options.claimId, 'claimId', { max: 200 }) || crypto.randomUUID();
    return this.claimStatement.get({
      id: messageId,
      claimId,
      now,
      leaseExpiresAt: now + leaseMs,
    }) || null;
  }

  markProcessed(id, claimId, completedAt) {
    return this.db.prepare(`
      UPDATE messages
      SET processing_status = 'PROCESSED',
          processing_claim_id = NULL,
          processing_lease_expires_at = NULL,
          processing_completed_at = @completedAt,
          processing_last_error = NULL
      WHERE id = @id AND processing_status = 'PROCESSING'
        AND processing_claim_id = @claimId
      RETURNING *
    `).get({
      id: requireInteger(id, 'id', { min: 1 }),
      claimId: requireString(claimId, 'claimId', { max: 200 }),
      completedAt: requireTimestamp(completedAt, 'completedAt'),
    }) || null;
  }

  markFailed(id, claimId, error, failedAt) {
    requireTimestamp(failedAt, 'failedAt');
    const message = String(error?.message || error || 'Message route failed').trim()
      || 'Message route failed';
    return this.db.prepare(`
      UPDATE messages
      SET processing_status = 'FAILED',
          processing_claim_id = NULL,
          processing_lease_expires_at = NULL,
          processing_completed_at = NULL,
          processing_last_error = @lastError
      WHERE id = @id AND processing_status = 'PROCESSING'
        AND processing_claim_id = @claimId
      RETURNING *
    `).get({
      id: requireInteger(id, 'id', { min: 1 }),
      claimId: requireString(claimId, 'claimId', { max: 200 }),
      lastError: message.slice(0, 4000),
    }) || null;
  }

  listWindow(chatId, start, end, { includeCommands = true, includeTombstones = false } = {}) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const windowStart = requireTimestamp(start, 'start');
    const windowEnd = requireTimestamp(end, 'end');
    if (windowEnd <= windowStart) throw new RangeError('end must be greater than start');
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ? AND sent_at >= ? AND sent_at < ?
        ${includeCommands ? '' : 'AND is_command = 0'}
        ${includeTombstones ? '' : 'AND is_tombstone = 0'}
      ORDER BY sent_at, id
    `).all(id, windowStart, windowEnd);
  }

  countWindow(chatId, start, end, { includeCommands = true, includeTombstones = false } = {}) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const windowStart = requireTimestamp(start, 'start');
    const windowEnd = requireTimestamp(end, 'end');
    if (windowEnd <= windowStart) throw new RangeError('end must be greater than start');
    return this.db.prepare(`
      SELECT count(*) AS count FROM messages
      WHERE chat_id = ? AND sent_at >= ? AND sent_at < ?
        ${includeCommands ? '' : 'AND is_command = 0'}
        ${includeTombstones ? '' : 'AND is_tombstone = 0'}
    `).get(id, windowStart, windowEnd).count;
  }

  listSummarySourcesWindow(chatId, start, end, options = {}) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const windowStart = requireTimestamp(start, 'start');
    const windowEnd = requireTimestamp(end, 'end');
    if (windowEnd <= windowStart) throw new RangeError('end must be greater than start');
    const includeCommands = options.includeCommands === true;
    const messages = this.listWindow(id, windowStart, windowEnd, {
      includeCommands,
      includeTombstones: false,
    });
    const markdownAttachments = this.db.prepare(`
      SELECT
        a.id AS attachment_id,
        a.attachment_uid,
        a.message_id,
        a.capture_message_id,
        a.capture_whatsapp_message_id,
        a.source_whatsapp_message_id AS whatsapp_message_id,
        a.source_sent_at AS sent_at,
        a.source_sender_jid AS sender_jid,
        sm.sender_display_name AS sender_display_name,
        m.sender_display_name AS capture_sender_display_name,
        a.display_name,
        a.retention_class,
        a.processing_status,
        COALESCE(a.parse_status,
          CASE
            WHEN a.processing_status = 'READY' AND a.extracted_text IS NOT NULL THEN 'PARSED'
            WHEN a.processing_status = 'FAILED' THEN 'FAILED'
            ELSE 'PENDING'
          END
        ) AS parse_status,
        a.extracted_text,
        a.extracted_char_count,
        a.extraction_truncated,
        a.parse_error,
        a.last_error_code,
        a.created_at AS attachment_created_at
      FROM attachments a
      JOIN messages m ON m.id = a.capture_message_id AND m.chat_id = a.chat_id
      LEFT JOIN messages sm ON sm.chat_id = a.chat_id
        AND sm.whatsapp_message_id = a.source_whatsapp_message_id
      WHERE m.chat_id = @chatId
        AND a.source_sent_at >= @windowStart AND a.source_sent_at < @windowEnd
        AND m.is_tombstone = 0 AND a.deleted_at IS NULL
        ${includeCommands ? '' : 'AND m.is_command = 0'}
        AND (
          a.detected_extension = 'md'
          OR lower(a.display_name) GLOB '*.md'
          OR lower(a.display_name) GLOB '*.markdown'
          OR lower(COALESCE(a.declared_mime, '')) IN (
            'text/markdown', 'text/x-markdown'
          )
        )
      ORDER BY m.sent_at, m.id, a.id
    `).all({ chatId: id, windowStart, windowEnd });
    return { messages, markdownAttachments };
  }

  updateBody(id, body) {
    const value = body === null ? null : String(body);
    return this.db.prepare(`
      UPDATE messages SET body = ?
      WHERE id = ? AND is_tombstone = 0 RETURNING *
    `).get(value, requireInteger(id, 'id', { min: 1 })) || null;
  }

  tombstone(id, deletedAt) {
    const timestamp = requireTimestamp(deletedAt, 'deletedAt');
    return this.db.prepare(`
      UPDATE messages
      SET body = NULL, is_tombstone = 1, deleted_at = COALESCE(deleted_at, ?)
      WHERE id = ? RETURNING *
    `).get(timestamp, requireInteger(id, 'id', { min: 1 })) || null;
  }
}

module.exports = { MessageRepository, MESSAGE_TYPES };
