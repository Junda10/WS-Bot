'use strict';

const {
  assertIdempotent,
  booleanInteger,
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
  }

  create(input) {
    const messageType = (input.messageType || 'TEXT').toUpperCase();
    if (!MESSAGE_TYPES.has(messageType)) throw new TypeError(`Unsupported messageType: ${messageType}`);
    const values = {
      messageUid: uid(input.messageUid, 'messageUid'),
      whatsappMessageId: requireString(input.whatsappMessageId, 'whatsappMessageId', { max: 500 }),
      chatId: requireInteger(input.chatId, 'chatId', { min: 1 }),
      senderJid: requireString(input.senderJid, 'senderJid', { max: 200 }),
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
        message_uid, whatsapp_message_id, chat_id, sender_jid, message_type, body,
        quoted_message_id, quoted_message_chat_id, quoted_whatsapp_message_id, sent_at, received_at,
        is_command, created_at
      ) VALUES (
        @messageUid, @whatsappMessageId, @chatId, @senderJid, @messageType, @body,
        @quotedMessageId, @quotedMessageChatId, @quotedWhatsappMessageId, @sentAt, @receivedAt,
        @isCommand, @createdAt
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
