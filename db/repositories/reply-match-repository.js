'use strict';

const {
  assertIdempotent,
  immediate,
  jsonValue,
  optionalString,
  requireDatabase,
  requireInteger,
  requireString,
  requireTimestamp,
  uid,
} = require('./shared');

const AI_STATUSES = new Set(['PROCESSING', 'MATCHED', 'NO_MATCH', 'FAILED', 'INVALID', 'LEGACY']);

function aiStatus(value) {
  const normalized = String(value || 'PROCESSING').toUpperCase();
  if (!AI_STATUSES.has(normalized)) throw new TypeError(`Unsupported aiStatus: ${value}`);
  return normalized;
}

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
        reason: String(candidate.reason || '').slice(0, 2000),
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
      sourceSenderJid: optionalString(input.sourceSenderJid, 'sourceSenderJid', { max: 200 }),
      sourceSentAt: input.sourceSentAt == null ? null : requireTimestamp(input.sourceSentAt, 'sourceSentAt'),
      sourceMediaJson: jsonValue(input.sourceMedia, 'sourceMedia'),
      aiStatus: aiStatus(input.aiStatus ?? 'PROCESSING'),
      expiresAt,
      createdAt,
    };

    return immediate(this.db, () => {
      const existing = this.bySource.get(values.chatId, values.sourceWhatsappMessageId);
      if (existing) {
        assertIdempotent(existing, {
          source_message_id: values.sourceMessageId,
          source_message_chat_id: values.sourceMessageChatId,
          eric_jid: values.ericJid,
          reply_text: values.replyText,
          source_sender_jid: values.sourceSenderJid,
          source_sent_at: values.sourceSentAt,
          source_media_json: values.sourceMediaJson,
        }, [
          'source_message_id', 'source_message_chat_id', 'eric_jid', 'reply_text',
          'source_sender_jid', 'source_sent_at', 'source_media_json',
        ], 'reply match session');
        return { record: existing, candidates: this.listCandidates(existing.id), created: false };
      }

      for (const candidate of candidates) {
        const issue = this.db.prepare(
          `SELECT chat_id, status, deleted_at FROM issues WHERE id = ?`
        ).get(candidate.issueId);
        if (!issue || issue.deleted_at !== null || !['WAITING_TEVAU', 'REPLIED'].includes(issue.status)) {
          throw new Error('Reply candidate issue not found or is not unresolved');
        }
        if (issue.chat_id !== chatId) throw new Error('Reply candidate issue belongs to a different chat');
      }

      const session = this.db.prepare(`
        INSERT INTO reply_match_sessions (
          session_uid, token, chat_id, source_message_id, source_message_chat_id,
          source_whatsapp_message_id, eric_jid, reply_text, status, expires_at,
          created_at, updated_at, source_sender_jid, source_sent_at,
          source_media_json, ai_status
        ) VALUES (
          @sessionUid, @token, @chatId, @sourceMessageId, @sourceMessageChatId,
          @sourceWhatsappMessageId, @ericJid, @replyText, 'PENDING', @expiresAt,
          @createdAt, @createdAt, @sourceSenderJid, @sourceSentAt,
          @sourceMediaJson, @aiStatus
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
      SELECT c.*, i.public_id, i.title, i.status
      FROM reply_match_candidates c
      JOIN issues i ON i.id = c.issue_id AND i.chat_id = c.chat_id
      WHERE c.session_id = ? ORDER BY c.position
    `).all(requireInteger(sessionId, 'sessionId', { min: 1 }));
  }

  findBySource(chatId, sourceWhatsappMessageId) {
    return this.bySource.get(
      requireInteger(chatId, 'chatId', { min: 1 }),
      requireString(sourceWhatsappMessageId, 'sourceWhatsappMessageId', { max: 500 })
    ) || null;
  }

  findByToken(token) {
    return this.db.prepare('SELECT * FROM reply_match_sessions WHERE token = ?').get(
      requireString(token, 'token', { min: 4, max: 128 })
    ) || null;
  }

  findBySuggestionMessage(chatId, whatsappMessageId) {
    return this.db.prepare(`
      SELECT * FROM reply_match_sessions
      WHERE chat_id = ? AND suggestion_whatsapp_message_id = ?
    `).get(
      requireInteger(chatId, 'chatId', { min: 1 }),
      requireString(whatsappMessageId, 'whatsappMessageId', { max: 500 })
    ) || null;
  }

  get(id) {
    return this.db.prepare('SELECT * FROM reply_match_sessions WHERE id = ?').get(
      requireInteger(id, 'id', { min: 1 })
    ) || null;
  }

  findReply(id) {
    return this.db.prepare('SELECT * FROM issue_replies WHERE id = ?').get(
      requireInteger(id, 'id', { min: 1 })
    ) || null;
  }

  finalizeAi(input) {
    const sessionId = requireInteger(input.sessionId, 'sessionId', { min: 1 });
    const status = aiStatus(input.aiStatus);
    if (status === 'PROCESSING' || status === 'LEGACY') throw new TypeError('AI result must be final');
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 3) {
      throw new TypeError('final AI candidates must contain 1..3 issues');
    }
    return immediate(this.db, () => {
      const session = this.get(sessionId);
      if (!session) throw new Error('Reply session not found');
      if (session.status !== 'PENDING' || session.ai_status !== 'PROCESSING') {
        return { record: session, candidates: this.listCandidates(session.id), finalized: false };
      }
      const existing = new Map(this.listCandidates(session.id).map((row) => [row.issue_id, row]));
      const candidates = input.candidates.map((candidate, index) => {
        const issueId = requireInteger(candidate.issueId, 'candidate.issueId', { min: 1 });
        if (!existing.has(issueId)) throw new Error('Final AI candidate was not in deterministic shortlist');
        const confidence = Number(candidate.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          throw new TypeError('candidate confidence must be from 0 to 1');
        }
        return {
          issueId,
          position: index + 1,
          confidence,
          reason: String(candidate.reason || '').slice(0, 2000),
        };
      });
      if (new Set(candidates.map((row) => row.issueId)).size !== candidates.length) {
        throw new TypeError('final AI candidates must be unique');
      }
      const values = {
        sessionId,
        aiStatus: status,
        selectedPublicId: optionalString(input.selectedPublicId, 'selectedPublicId', { max: 50 }),
        confidence: optionalString(input.confidence, 'confidence', { max: 20 }),
        reason: input.reason == null ? null : String(input.reason).slice(0, 2000),
        model: optionalString(input.model, 'model', { max: 300 }),
        attempts: requireInteger(input.attempts ?? 0, 'attempts'),
        errorCode: optionalString(input.errorCode, 'errorCode', { max: 100 }),
        errorMessage: input.errorMessage == null ? null : String(input.errorMessage).slice(0, 2000),
        now: requireTimestamp(input.now, 'now'),
      };

      // This guarded write is the first mutation in the IMMEDIATE transaction.
      // It claims only a still-pending/still-processing session; the write lock
      // then prevents confirmation/cancellation from interleaving with the
      // candidate replacement and final AI update below.
      const claimed = this.db.prepare(`
        UPDATE reply_match_sessions SET updated_at = max(updated_at, @now)
        WHERE id = @sessionId AND status = 'PENDING' AND ai_status = 'PROCESSING'
        RETURNING *
      `).get(values);
      if (!claimed) {
        const current = this.get(sessionId);
        return { record: current, candidates: this.listCandidates(sessionId), finalized: false };
      }

      this.db.prepare('DELETE FROM reply_match_candidates WHERE session_id = ?').run(claimed.id);
      const insert = this.db.prepare(`
        INSERT INTO reply_match_candidates(session_id, issue_id, chat_id, position, confidence, reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of candidates) {
        insert.run(claimed.id, candidate.issueId, claimed.chat_id, candidate.position,
          candidate.confidence, candidate.reason);
      }
      const record = this.db.prepare(`
        UPDATE reply_match_sessions SET
          ai_status = @aiStatus, ai_selected_public_id = @selectedPublicId,
          ai_confidence = @confidence, ai_reason = @reason, ai_model = @model,
          ai_attempts = @attempts, ai_error_code = @errorCode,
          ai_error_message = @errorMessage, updated_at = @now
        WHERE id = @sessionId AND status = 'PENDING' AND ai_status = 'PROCESSING'
        RETURNING *
      `).get(values);
      if (!record) throw new Error('Reply AI session changed during claimed finalization');
      return { record, candidates: this.listCandidates(claimed.id), finalized: true };
    });
  }

  markInterrupted(sessionId, now) {
    const current = this.get(sessionId);
    if (!current || current.ai_status !== 'PROCESSING') return current;
    return this.finalizeAi({
      sessionId,
      aiStatus: 'FAILED',
      candidates: this.listCandidates(sessionId).map((row) => ({
        issueId: row.issue_id, confidence: row.confidence,
        reason: 'AI 匹配中断；保留确定性候选供 Eric 安全选择',
      })),
      confidence: 'low',
      reason: 'AI 匹配在重启前未完成，未自动写入任何回复',
      attempts: 0,
      errorCode: 'AI_INTERRUPTED',
      errorMessage: 'Prior reply matching process did not finalize',
      now,
    }).record;
  }

  bindSuggestion(input) {
    return this._bindMessage('suggestion', input);
  }

  bindConfirmation(input) {
    return this._bindMessage('confirmation', input);
  }

  _bindMessage(kind, input) {
    const idColumn = `${kind}_whatsapp_message_id`;
    const sentColumn = `${kind}_sent_at`;
    const sessionId = requireInteger(input.sessionId, 'sessionId', { min: 1 });
    const whatsappId = requireString(input.whatsappMessageId, 'whatsappMessageId', { max: 500 });
    const sentAt = requireTimestamp(input.sentAt, 'sentAt');
    return immediate(this.db, () => {
      const current = this.get(sessionId);
      if (!current) throw new Error('Reply session not found');
      if (sentAt < current.created_at) throw new RangeError(`Reply ${kind} sentAt predates session`);
      if (current[idColumn] !== null) {
        if (current[idColumn] !== whatsappId) throw new Error(`Reply ${kind} message is already bound`);
        return current;
      }
      return this.db.prepare(`
        UPDATE reply_match_sessions SET ${idColumn} = ?, ${sentColumn} = ?, updated_at = max(updated_at, ?)
        WHERE id = ? AND ${idColumn} IS NULL RETURNING *
      `).get(whatsappId, sentAt, sentAt, sessionId) || this.get(sessionId);
    });
  }

  expirePending(input) {
    const now = requireTimestamp(input.now, 'now');
    return this.db.prepare(`
      UPDATE reply_match_sessions SET status = 'EXPIRED', updated_at = @now
      WHERE token = @token AND status = 'PENDING' AND expires_at < @now
      RETURNING *
    `).get({
      token: requireString(input.token, 'token', { min: 4, max: 128 }),
      now,
    }) || null;
  }

  confirmationResult(session) {
    const reply = this.db.prepare('SELECT * FROM issue_replies WHERE session_id = ?').get(session.id);
    if (!reply) return null;
    const issue = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(reply.current_issue_id);
    const event = this.db.prepare(`
      SELECT * FROM issue_events
      WHERE event_type = 'REPLY_CONFIRMED' AND after_json ->> '$.replyId' = ?
      ORDER BY id LIMIT 1
    `).get(reply.id);
    return { ...session, session, reply, issue, event, replayed: true };
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

      const current = this.findByToken(token);
      if (current?.status === 'CONFIRMED' && current.eric_jid === ericJid
          && current.selected_issue_id === issueId) {
        return this.confirmationResult(current);
      }

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
          reply_text, confirmed_by_jid, confirmed_at, created_at,
          source_sender_jid, source_sent_at, source_media_json
        ) VALUES (
          @replyUid, @sessionId, @chatId, @issueId, @issueId,
          @sourceMessageId, @sourceMessageChatId, @sourceWhatsappMessageId,
          @replyText, @ericJid, @now, @now,
          @sourceSenderJid, @sourceSentAt, @sourceMediaJson
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
        sourceSenderJid: session.source_sender_jid,
        sourceSentAt: session.source_sent_at,
        sourceMediaJson: session.source_media_json,
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
          reply_text, before_json, after_json, reason, occurred_at, created_at
        ) VALUES (
          @eventUid, @issueId, @chatId, 'REPLY_CONFIRMED', @ericJid,
          @sourceMessageId, @sourceMessageChatId, @sourceWhatsappMessageId,
          @replyText, @beforeJson, @afterJson, @reason, @now, @now
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
        reason: input.reason == null ? null : String(input.reason),
        now,
      });

      return { ...session, session, reply, issue: updatedIssue, event, replayed: false };
    });
  }

  cancel(input) {
    const token = requireString(input.token, 'token', { min: 4, max: 128 });
    const ericJid = requireString(input.ericJid, 'ericJid', { max: 200 });
    const now = requireTimestamp(input.now, 'now');
    return immediate(this.db, () => {
      this.db.prepare(`
        UPDATE reply_match_sessions SET status = 'EXPIRED', updated_at = ?
        WHERE token = ? AND status = 'PENDING' AND expires_at < ?
      `).run(now, token, now);
      const current = this.findByToken(token);
      if (current?.eric_jid !== ericJid) return null;
      if (current.status === 'CANCELLED') return { ...current, replayed: true };
      if (current.status !== 'PENDING') return null;
      const record = this.db.prepare(`
        UPDATE reply_match_sessions SET status = 'CANCELLED', consumed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING' RETURNING *
      `).get(now, now, current.id);
      return record ? { ...record, replayed: false } : null;
    });
  }
}

module.exports = { AI_STATUSES, ReplyMatchRepository };
