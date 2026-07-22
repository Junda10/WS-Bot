'use strict';

const {
  assertIdempotent,
  immediate,
  jsonValue,
  requireDatabase,
  requireInteger,
  requireString,
  requireTimestamp,
  uid,
} = require('./shared');

class ReplyMatchRepository {
  constructor(db) {
    this.db = requireDatabase(db);
    this.bySource = db.prepare(`
      SELECT * FROM reply_match_sessions
      WHERE chat_id = ? AND source_whatsapp_message_id = ?
    `);
  }

  create(input) {
    const createdAt = requireTimestamp(input.createdAt, 'createdAt');
    const expiresAt = requireTimestamp(input.expiresAt, 'expiresAt');
    if (expiresAt < createdAt) throw new RangeError('expiresAt must be >= createdAt');
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 3) {
      throw new TypeError('candidates must contain 1..3 issues');
    }
    const chatId = requireInteger(input.chatId, 'chatId', { min: 1 });
    const candidates = input.candidates.map((candidate, index) => {
      const confidence = Number(candidate.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new TypeError('candidate confidence must be from 0 to 1');
      }
      return {
        issueId: requireInteger(candidate.issueId, 'candidate.issueId', { min: 1 }),
        position: index + 1,
        confidence,
        reason: String(candidate.reason || ''),
      };
    });
    if (new Set(candidates.map((candidate) => candidate.issueId)).size !== candidates.length) {
      throw new TypeError('candidate issues must be unique');
    }

    let sourceMessageId = input.sourceMessageId == null
      ? null
      : requireInteger(input.sourceMessageId, 'sourceMessageId', { min: 1 });
    let sourceMessageChatId = null;
    let sourceWhatsappMessageId = requireString(
      input.sourceWhatsappMessageId, 'sourceWhatsappMessageId', { max: 500 }
    );
    if (sourceMessageId !== null) {
      const message = this.db.prepare(
        'SELECT chat_id, whatsapp_message_id FROM messages WHERE id = ?'
      ).get(sourceMessageId);
      if (!message) throw new Error('Reply source message not found');
      if (message.chat_id !== chatId) throw new Error('Reply source message belongs to a different chat');
      if (sourceWhatsappMessageId !== message.whatsapp_message_id) {
        throw new Error('Reply source WhatsApp snapshot does not match');
      }
      sourceMessageChatId = message.chat_id;
      sourceWhatsappMessageId = message.whatsapp_message_id;
    }

    const values = {
      sessionUid: uid(input.sessionUid, 'sessionUid'),
      token: requireString(input.token, 'token', { min: 4, max: 128 }),
      chatId,
      sourceMessageId,
      sourceMessageChatId,
      sourceWhatsappMessageId,
      ericJid: requireString(input.ericJid, 'ericJid', { max: 200 }),
      replyText: requireString(input.replyText, 'replyText', { max: 1000000 }),
      expiresAt,
      createdAt,
    };

    return immediate(this.db, () => {
      const existing = this.bySource.get(values.chatId, values.sourceWhatsappMessageId);
      if (existing) {
        assertIdempotent(existing, {
          eric_jid: values.ericJid, reply_text: values.replyText,
        }, ['eric_jid', 'reply_text'], 'reply match session');
        return { record: existing, candidates: this.listCandidates(existing.id), created: false };
      }

      for (const candidate of candidates) {
        const issue = this.db.prepare('SELECT chat_id, deleted_at FROM issues WHERE id = ?').get(candidate.issueId);
        if (!issue || issue.deleted_at !== null) throw new Error('Reply candidate issue not found');
        if (issue.chat_id !== chatId) throw new Error('Reply candidate issue belongs to a different chat');
      }

      const session = this.db.prepare(`
        INSERT INTO reply_match_sessions (
          session_uid, token, chat_id, source_message_id, source_message_chat_id,
          source_whatsapp_message_id, eric_jid, reply_text, status, expires_at,
          created_at, updated_at
        ) VALUES (
          @sessionUid, @token, @chatId, @sourceMessageId, @sourceMessageChatId,
          @sourceWhatsappMessageId, @ericJid, @replyText, 'PENDING', @expiresAt,
          @createdAt, @createdAt
        ) RETURNING *
      `).get(values);
      const insertCandidate = this.db.prepare(`
        INSERT INTO reply_match_candidates (
          session_id, issue_id, chat_id, position, confidence, reason
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of candidates) {
        insertCandidate.run(
          session.id, candidate.issueId, chatId, candidate.position,
          candidate.confidence, candidate.reason
        );
      }
      return { record: session, candidates: this.listCandidates(session.id), created: true };
    });
  }

  listCandidates(sessionId) {
    return this.db.prepare(`
      SELECT c.*, i.public_id, i.title
      FROM reply_match_candidates c
      JOIN issues i ON i.id = c.issue_id AND i.chat_id = c.chat_id
      WHERE c.session_id = ? ORDER BY c.position
    `).all(requireInteger(sessionId, 'sessionId', { min: 1 }));
  }

  findByToken(token) {
    return this.db.prepare('SELECT * FROM reply_match_sessions WHERE token = ?').get(
      requireString(token, 'token', { min: 4, max: 128 })
    ) || null;
  }

  findReply(id) {
    return this.db.prepare('SELECT * FROM issue_replies WHERE id = ?').get(
      requireInteger(id, 'id', { min: 1 })
    ) || null;
  }

  confirm(input) {
    const token = requireString(input.token, 'token', { min: 4, max: 128 });
    const ericJid = requireString(input.ericJid, 'ericJid', { max: 200 });
    const issueId = requireInteger(input.issueId, 'issueId', { min: 1 });
    const now = requireTimestamp(input.now, 'now');
    const eventUid = uid(input.eventUid, 'eventUid');
    const replyUid = uid(input.replyUid, 'replyUid');

    return immediate(this.db, () => {
      this.db.prepare(`
        UPDATE reply_match_sessions SET status = 'EXPIRED', updated_at = ?
        WHERE token = ? AND status = 'PENDING' AND expires_at < ?
      `).run(now, token, now);

      const pending = this.db.prepare(`
        SELECT s.* FROM reply_match_sessions s
        WHERE s.token = @token AND s.eric_jid = @ericJid
          AND s.status = 'PENDING' AND s.expires_at >= @now
          AND EXISTS (
            SELECT 1 FROM reply_match_candidates c
            WHERE c.session_id = s.id AND c.chat_id = s.chat_id AND c.issue_id = @issueId
          )
      `).get({ token, ericJid, issueId, now });
      if (!pending) return null;

      const issue = this.db.prepare(`
        SELECT * FROM issues
        WHERE id = ? AND chat_id = ? AND deleted_at IS NULL
          AND status IN ('WAITING_TEVAU', 'REPLIED')
      `).get(issueId, pending.chat_id);
      if (!issue) throw new Error('Selected issue is unavailable for reply confirmation');

      const session = this.db.prepare(`
        UPDATE reply_match_sessions
        SET status = 'CONFIRMED', selected_issue_id = @issueId,
            selected_issue_chat_id = chat_id, consumed_at = @now, updated_at = @now
        WHERE id = @id AND status = 'PENDING' RETURNING *
      `).get({ id: pending.id, issueId, now });
      if (!session) return null;

      const reply = this.db.prepare(`
        INSERT INTO issue_replies (
          reply_uid, session_id, chat_id, original_issue_id, current_issue_id,
          source_message_id, source_message_chat_id, source_whatsapp_message_id,
          reply_text, confirmed_by_jid, confirmed_at, created_at
        ) VALUES (
          @replyUid, @sessionId, @chatId, @issueId, @issueId,
          @sourceMessageId, @sourceMessageChatId, @sourceWhatsappMessageId,
          @replyText, @ericJid, @now, @now
        ) RETURNING *
      `).get({
        replyUid,
        sessionId: session.id,
        chatId: session.chat_id,
        issueId,
        sourceMessageId: session.source_message_id,
        sourceMessageChatId: session.source_message_chat_id,
        sourceWhatsappMessageId: session.source_whatsapp_message_id,
        replyText: session.reply_text,
        ericJid,
        now,
      });

      const updatedIssue = this.db.prepare(`
        UPDATE issues
        SET status = CASE WHEN status = 'WAITING_TEVAU' THEN 'REPLIED' ELSE status END,
            first_replied_at = COALESCE(first_replied_at, @now),
            updated_at = @now, revision = revision + 1
        WHERE id = @issueId AND chat_id = @chatId AND deleted_at IS NULL
        RETURNING *
      `).get({ issueId, chatId: session.chat_id, now });
      if (!updatedIssue) throw new Error('Selected issue disappeared during confirmation');

      const event = this.db.prepare(`
        INSERT INTO issue_events (
          event_uid, issue_id, chat_id, event_type, actor_jid,
          source_message_id, source_message_chat_id, source_whatsapp_message_id,
          reply_text, before_json, after_json, occurred_at, created_at
        ) VALUES (
          @eventUid, @issueId, @chatId, 'REPLY_CONFIRMED', @ericJid,
          @sourceMessageId, @sourceMessageChatId, @sourceWhatsappMessageId,
          @replyText, @beforeJson, @afterJson, @now, @now
        ) RETURNING *
      `).get({
        eventUid,
        issueId,
        chatId: session.chat_id,
        ericJid,
        sourceMessageId: session.source_message_id,
        sourceMessageChatId: session.source_message_chat_id,
        sourceWhatsappMessageId: session.source_whatsapp_message_id,
        replyText: session.reply_text,
        beforeJson: jsonValue({ status: issue.status, firstRepliedAt: issue.first_replied_at }, 'before'),
        afterJson: jsonValue({
          status: updatedIssue.status,
          firstRepliedAt: updatedIssue.first_replied_at,
          replyId: reply.id,
        }, 'after'),
        now,
      });

      return { ...session, session, reply, issue: updatedIssue, event };
    });
  }

  cancel(input) {
    return this.db.prepare(`
      UPDATE reply_match_sessions SET status = 'CANCELLED', updated_at = ?
      WHERE token = ? AND eric_jid = ? AND status = 'PENDING' RETURNING *
    `).get(
      requireTimestamp(input.now, 'now'),
      requireString(input.token, 'token', { min: 4, max: 128 }),
      requireString(input.ericJid, 'ericJid', { max: 200 })
    ) || null;
  }
}

module.exports = { ReplyMatchRepository };
