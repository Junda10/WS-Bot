'use strict';

const {
  assertIdempotent,
  booleanInteger,
  requireDatabase,
  requireString,
  requireTimestamp,
  uid,
} = require('./shared');

class ChatRepository {
  constructor(db) {
    this.db = requireDatabase(db);
    this.insert = db.prepare(`
      INSERT INTO chats (chat_uid, jid, timezone, enabled, created_at, updated_at)
      VALUES (@chatUid, @jid, @timezone, @enabled, @now, @now)
      ON CONFLICT(jid) DO NOTHING
      RETURNING *
    `);
    this.byJid = db.prepare('SELECT * FROM chats WHERE jid = ?');
    this.byUid = db.prepare('SELECT * FROM chats WHERE chat_uid = ?');
  }

  create(input) {
    const values = {
      chatUid: uid(input.chatUid, 'chatUid'),
      jid: requireString(input.jid, 'jid', { max: 200 }),
      timezone: requireString(input.timezone, 'timezone', { max: 100 }),
      enabled: booleanInteger(input.enabled, true),
      now: requireTimestamp(input.now, 'now'),
    };
    const created = this.insert.get(values);
    if (created) return { record: created, created: true };

    const existing = this.byJid.get(values.jid);
    assertIdempotent(existing, {
      timezone: values.timezone,
    }, ['timezone'], 'chat');
    return { record: existing, created: false };
  }

  findByJid(jid, { includeDeleted = false } = {}) {
    const record = this.byJid.get(requireString(jid, 'jid', { max: 200 })) || null;
    return includeDeleted || !record || record.deleted_at === null ? record : null;
  }

  findByUid(chatUid, { includeDeleted = false } = {}) {
    const record = this.byUid.get(requireString(chatUid, 'chatUid', { max: 200 })) || null;
    return includeDeleted || !record || record.deleted_at === null ? record : null;
  }

  setEnabled(id, enabled, now) {
    const result = this.db.prepare(`
      UPDATE chats SET enabled = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
      RETURNING *
    `).get(booleanInteger(enabled), requireTimestamp(now, 'now'), id);
    return result || null;
  }
}

module.exports = { ChatRepository };
