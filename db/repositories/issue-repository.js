'use strict';

const {
  assertIdempotent,
  immediate,
  jsonValue,
  normalizeSearchQuery,
  optionalString,
  requireDatabase,
  requireInteger,
  requireString,
  requireTimestamp,
  uid,
} = require('./shared');

const ISSUE_STATUSES = new Set(['WAITING_TEVAU', 'REPLIED', 'RESOLVED', 'ARCHIVED']);
const EVENT_TYPES = new Set([
  'CREATED', 'UPDATED', 'REPLY_CONFIRMED', 'RESOLVED', 'ARCHIVED',
  'RESTORED', 'DELETED', 'REPLY_MOVED',
]);

function enumValue(value, name, allowed) {
  const normalized = requireString(value, name, { max: 50 }).toUpperCase();
  if (!allowed.has(normalized)) throw new TypeError(`Unsupported ${name}: ${value}`);
  return normalized;
}

class IssueRepository {
  constructor(db) {
    this.db = requireDatabase(db);
    this.byIdempotencyKey = db.prepare('SELECT * FROM issues WHERE idempotency_key = ?');
    this.byPublicId = db.prepare('SELECT * FROM issues WHERE public_id = ?');
    this.byId = db.prepare('SELECT * FROM issues WHERE id = ?');
    this.eventByUid = db.prepare('SELECT * FROM issue_events WHERE event_uid = ?');
    this.messageById = db.prepare('SELECT id, chat_id, whatsapp_message_id FROM messages WHERE id = ?');
  }

  allocateSequence(now) {
    const row = this.db.prepare(`
      UPDATE sequences SET next_value = next_value + 1, updated_at = ?
      WHERE name = 'issue_tv' RETURNING next_value - 1 AS value
    `).get(requireTimestamp(now, 'now'));
    if (!row) throw new Error('issue_tv sequence is missing');
    return row.value;
  }

  resolveSource(sourceMessageId, suppliedSnapshot, expectedChatId, label = 'source message') {
    if (sourceMessageId == null) {
      return {
        sourceMessageId: null,
        sourceMessageChatId: null,
        sourceWhatsappMessageId: optionalString(suppliedSnapshot, 'sourceWhatsappMessageId', { max: 500 }),
      };
    }
    const id = requireInteger(sourceMessageId, 'sourceMessageId', { min: 1 });
    const message = this.messageById.get(id);
    if (!message) throw new Error(`${label} not found`);
    if (message.chat_id !== expectedChatId) throw new Error(`${label} belongs to a different chat`);
    if (suppliedSnapshot != null && suppliedSnapshot !== message.whatsapp_message_id) {
      throw new Error(`${label} WhatsApp snapshot does not match`);
    }
    return {
      sourceMessageId: message.id,
      sourceMessageChatId: message.chat_id,
      sourceWhatsappMessageId: message.whatsapp_message_id,
    };
  }

  create(input) {
    const values = {
      issueUid: uid(input.issueUid, 'issueUid'),
      chatId: requireInteger(input.chatId, 'chatId', { min: 1 }),
      title: requireString(input.title, 'title', { max: 300 }),
      description: typeof input.description === 'string' ? input.description : '',
      status: enumValue(input.status || 'WAITING_TEVAU', 'status', ISSUE_STATUSES),
      createdByJid: requireString(input.createdByJid, 'createdByJid', { max: 200 }),
      ownerJid: optionalString(input.ownerJid, 'ownerJid', { max: 200 }),
      idempotencyKey: optionalString(input.idempotencyKey, 'idempotencyKey', { max: 500 }),
      now: requireTimestamp(input.now, 'now'),
      eventUid: uid(input.eventUid, 'eventUid'),
    };
    if (values.description.length > 1000000) throw new TypeError('description is too long');

    return immediate(this.db, () => {
      if (values.idempotencyKey) {
        const existing = this.byIdempotencyKey.get(values.idempotencyKey);
        if (existing) {
          assertIdempotent(existing, {
            chat_id: values.chatId, title: values.title, description: values.description,
          }, ['chat_id', 'title', 'description'], 'issue');
          return { record: existing, created: false };
        }
      }

      Object.assign(values, this.resolveSource(
        input.sourceMessageId, input.sourceWhatsappMessageId, values.chatId
      ));
      const sequenceNumber = this.allocateSequence(values.now);
      const issue = this.db.prepare(`
        INSERT INTO issues (
          issue_uid, sequence_number, public_id, chat_id, title, description, status,
          created_by_jid, owner_jid, source_message_id, source_message_chat_id,
          source_whatsapp_message_id, idempotency_key, created_at, updated_at
        ) VALUES (
          @issueUid, @sequenceNumber, @publicId, @chatId, @title, @description, @status,
          @createdByJid, @ownerJid, @sourceMessageId, @sourceMessageChatId,
          @sourceWhatsappMessageId, @idempotencyKey, @now, @now
        ) RETURNING *
      `).get({ ...values, sequenceNumber, publicId: `TV${sequenceNumber}` });

      this.insertEvent({
        eventUid: values.eventUid,
        issueId: issue.id,
        eventType: 'CREATED',
        actorJid: values.createdByJid,
        sourceMessageId: values.sourceMessageId,
        sourceWhatsappMessageId: values.sourceWhatsappMessageId,
        after: {
          publicId: issue.public_id,
          title: issue.title,
          description: issue.description,
          status: issue.status,
          ownerJid: issue.owner_jid,
          firstRepliedAt: issue.first_replied_at,
          resolvedAt: issue.resolved_at,
          archivedAt: issue.archived_at,
          deletedAt: issue.deleted_at,
          revision: issue.revision,
        },
        reason: input.reason,
        occurredAt: values.now,
        createdAt: values.now,
      });
      return { record: issue, created: true };
    });
  }

  insertEvent(input) {
    const eventType = enumValue(input.eventType, 'eventType', EVENT_TYPES);
    const replyText = input.replyText == null
      ? null
      : requireString(input.replyText, 'replyText', { max: 1000000 });
    if ((eventType === 'REPLY_CONFIRMED') !== (replyText !== null)) {
      throw new TypeError('replyText is required only for REPLY_CONFIRMED events');
    }
    const issueId = requireInteger(input.issueId, 'issueId', { min: 1 });
    const issue = this.byId.get(issueId);
    if (!issue) throw new Error('Issue not found');
    const source = this.resolveSource(
      input.sourceMessageId, input.sourceWhatsappMessageId, issue.chat_id, 'event source message'
    );
    const occurredAt = requireTimestamp(input.occurredAt, 'occurredAt');
    const createdAt = requireTimestamp(input.createdAt ?? input.occurredAt, 'createdAt');
    const values = {
      eventUid: uid(input.eventUid, 'eventUid'),
      issueId,
      chatId: issue.chat_id,
      eventType,
      actorJid: requireString(input.actorJid, 'actorJid', { max: 200 }),
      ...source,
      replyText,
      beforeJson: jsonValue(input.before, 'before'),
      afterJson: jsonValue(input.after, 'after'),
      reason: input.reason == null ? null : String(input.reason),
      occurredAt,
      createdAt,
    };
    const created = this.db.prepare(`
      INSERT INTO issue_events (
        event_uid, issue_id, chat_id, event_type, actor_jid, source_message_id,
        source_message_chat_id, source_whatsapp_message_id, reply_text,
        before_json, after_json, reason, occurred_at, created_at
      ) VALUES (
        @eventUid, @issueId, @chatId, @eventType, @actorJid, @sourceMessageId,
        @sourceMessageChatId, @sourceWhatsappMessageId, @replyText,
        @beforeJson, @afterJson, @reason, @occurredAt, @createdAt
      ) ON CONFLICT(event_uid) DO NOTHING RETURNING *
    `).get(values);
    if (created) return created;
    const existing = this.db.prepare('SELECT * FROM issue_events WHERE event_uid = ?').get(values.eventUid);
    assertIdempotent(existing, {
      issue_id: values.issueId,
      event_type: values.eventType,
      actor_jid: values.actorJid,
      source_whatsapp_message_id: values.sourceWhatsappMessageId,
      reply_text: values.replyText,
      before_json: values.beforeJson,
      after_json: values.afterJson,
      reason: values.reason,
      occurred_at: values.occurredAt,
    }, [
      'issue_id', 'event_type', 'actor_jid', 'source_whatsapp_message_id',
      'reply_text', 'before_json', 'after_json', 'reason', 'occurred_at',
    ], 'issue event');
    return existing;
  }

  appendEvent(input) {
    if (String(input.eventType).toUpperCase() === 'REPLY_CONFIRMED') {
      throw new Error('Confirmed replies must use replyMatches.confirm() atomically');
    }
    return immediate(this.db, () => this.insertEvent(input));
  }

  findByPublicId(publicId, { includeDeleted = false } = {}) {
    const row = this.byPublicId.get(
      requireString(publicId, 'publicId', { max: 50 }).toUpperCase()
    ) || null;
    return includeDeleted || !row || row.deleted_at === null ? row : null;
  }

  findById(id, { includeDeleted = false } = {}) {
    const row = this.byId.get(requireInteger(id, 'id', { min: 1 })) || null;
    return includeDeleted || !row || row.deleted_at === null ? row : null;
  }

  listOpen(chatId) {
    return this.db.prepare(`
      SELECT i.*,
        (SELECT count(*) FROM attachments a
         WHERE a.issue_id = i.id AND a.deleted_at IS NULL) AS attachment_count
      FROM issues i
      WHERE i.chat_id = ? AND i.deleted_at IS NULL
        AND i.status IN ('WAITING_TEVAU', 'REPLIED')
      ORDER BY i.id
    `).all(requireInteger(chatId, 'chatId', { min: 1 }));
  }

  findBySourceWhatsappMessageId(sourceWhatsappMessageId, chatId, {
    includeDeleted = false,
  } = {}) {
    const sourceId = requireString(
      sourceWhatsappMessageId,
      'sourceWhatsappMessageId',
      { max: 500 }
    );
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    return this.db.prepare(`
      SELECT DISTINCT i.*
      FROM issues i
      WHERE i.chat_id = @chatId
        ${includeDeleted ? '' : 'AND i.deleted_at IS NULL'}
        AND (
          i.source_whatsapp_message_id = @sourceId
          OR EXISTS (
            SELECT 1 FROM issue_events e
            WHERE e.issue_id = i.id AND e.source_whatsapp_message_id = @sourceId
          )
          OR EXISTS (
            SELECT 1 FROM issue_replies r
            WHERE r.current_issue_id = i.id AND r.source_whatsapp_message_id = @sourceId
          )
        )
      ORDER BY i.id
    `).all({ chatId: id, sourceId });
  }

  findEventByUid(eventUid) {
    return this.eventByUid.get(requireString(eventUid, 'eventUid', { max: 200 })) || null;
  }

  listEvents(issueId) {
    return this.db.prepare(`
      SELECT * FROM issue_events WHERE issue_id = ? ORDER BY occurred_at, id
    `).all(requireInteger(issueId, 'issueId', { min: 1 }));
  }

  listReplies(issueId) {
    return this.db.prepare(`
      SELECT * FROM issue_replies WHERE current_issue_id = ? ORDER BY confirmed_at, id
    `).all(requireInteger(issueId, 'issueId', { min: 1 }));
  }

  update(id, patch, now) {
    const issueId = requireInteger(id, 'id', { min: 1 });
    const timestamp = requireTimestamp(now, 'now');
    const columns = [];
    const values = { id: issueId, now: timestamp };
    // Every possible identifier is selected from this closed map; no caller text
    // is ever interpolated as SQL.
    const mappings = {
      title: ['title', (value) => requireString(value, 'title', { max: 300 })],
      description: ['description', (value) => {
        const text = String(value);
        if (text.length > 1000000) throw new TypeError('description is too long');
        return text;
      }],
      status: ['status', (value) => enumValue(value, 'status', ISSUE_STATUSES)],
      ownerJid: ['owner_jid', (value) => optionalString(value, 'ownerJid', { max: 200 })],
      firstRepliedAt: ['first_replied_at', (value) => value == null ? null : requireTimestamp(value, 'firstRepliedAt')],
      resolvedAt: ['resolved_at', (value) => value == null ? null : requireTimestamp(value, 'resolvedAt')],
      archivedAt: ['archived_at', (value) => value == null ? null : requireTimestamp(value, 'archivedAt')],
    };
    for (const [key, [column, validate]] of Object.entries(mappings)) {
      if (Object.hasOwn(patch, key)) {
        columns.push(`${column} = @${key}`);
        values[key] = validate(patch[key]);
      }
    }
    if (!columns.length) throw new TypeError('No supported issue fields supplied');
    columns.push('updated_at = @now', 'revision = revision + 1');
    return this.db.prepare(`
      UPDATE issues SET ${columns.join(', ')}
      WHERE id = @id AND deleted_at IS NULL RETURNING *
    `).get(values) || null;
  }

  moveReply(input) {
    const replyId = requireInteger(input.replyId, 'replyId', { min: 1 });
    const targetIssueId = requireInteger(input.toIssueId, 'toIssueId', { min: 1 });
    const now = requireTimestamp(input.now, 'now');
    const actorJid = requireString(input.actorJid, 'actorJid', { max: 200 });
    const eventUid = uid(input.eventUid, 'eventUid');
    const sourceEventUid = uid(input.sourceEventUid, 'sourceEventUid');
    return immediate(this.db, () => {
      const reply = this.db.prepare('SELECT * FROM issue_replies WHERE id = ?').get(replyId);
      if (!reply) throw new Error('Confirmed reply not found');
      const source = this.byId.get(reply.current_issue_id);
      const target = this.byId.get(targetIssueId);
      if (!source || source.deleted_at !== null) throw new Error('Source issue not found');
      if (!target || target.deleted_at !== null) throw new Error('Target issue not found');
      if (target.chat_id !== reply.chat_id) throw new Error('Target issue belongs to a different chat');
      if (reply.current_issue_id === targetIssueId) throw new Error('Reply is already linked to target issue');
      const oldIssueId = reply.current_issue_id;

      const moved = this.db.prepare(`
        UPDATE issue_replies SET current_issue_id = ? WHERE id = ? RETURNING *
      `).get(targetIssueId, replyId);

      this.db.prepare(`
        UPDATE issues
        SET first_replied_at = (SELECT min(confirmed_at) FROM issue_replies WHERE current_issue_id = issues.id),
            status = CASE
              WHEN id = @targetId AND status = 'WAITING_TEVAU' THEN 'REPLIED'
              WHEN id = @oldId AND status = 'REPLIED'
                   AND NOT EXISTS (SELECT 1 FROM issue_replies WHERE current_issue_id = @oldId)
                THEN 'WAITING_TEVAU'
              ELSE status END,
            updated_at = @now, revision = revision + 1
        WHERE id IN (@oldId, @targetId)
      `).run({ oldId: oldIssueId, targetId: targetIssueId, now });

      const updatedSource = this.byId.get(oldIssueId);
      const updatedTarget = this.byId.get(targetIssueId);
      const movementBefore = {
        replyId,
        issueId: oldIssueId,
        sourceStatus: source.status,
        sourceFirstRepliedAt: source.first_replied_at,
        sourceResolvedAt: source.resolved_at,
        sourceArchivedAt: source.archived_at,
        targetStatus: target.status,
        targetFirstRepliedAt: target.first_replied_at,
        targetResolvedAt: target.resolved_at,
        targetArchivedAt: target.archived_at,
      };
      const movementAfter = {
        replyId,
        issueId: targetIssueId,
        sourceStatus: updatedSource.status,
        sourceFirstRepliedAt: updatedSource.first_replied_at,
        sourceResolvedAt: updatedSource.resolved_at,
        sourceArchivedAt: updatedSource.archived_at,
        targetStatus: updatedTarget.status,
        targetFirstRepliedAt: updatedTarget.first_replied_at,
        targetResolvedAt: updatedTarget.resolved_at,
        targetArchivedAt: updatedTarget.archived_at,
      };
      const sourceEvent = this.insertEvent({
        eventUid: sourceEventUid,
        issueId: oldIssueId,
        eventType: 'REPLY_MOVED',
        actorJid,
        before: movementBefore,
        after: movementAfter,
        reason: input.reason,
        occurredAt: now,
      });
      const event = this.insertEvent({
        eventUid,
        issueId: targetIssueId,
        eventType: 'REPLY_MOVED',
        actorJid,
        before: movementBefore,
        after: movementAfter,
        reason: input.reason,
        occurredAt: now,
      });
      return {
        reply: moved,
        sourceIssue: updatedSource,
        targetIssue: updatedTarget,
        sourceEvent,
        event,
      };
    });
  }

  softDelete(id, deletedAt) {
    const timestamp = requireTimestamp(deletedAt, 'deletedAt');
    return this.db.prepare(`
      UPDATE issues
      SET deleted_at = COALESCE(deleted_at, @now), updated_at = @now, revision = revision + 1
      WHERE id = @id RETURNING *
    `).get({ id: requireInteger(id, 'id', { min: 1 }), now: timestamp }) || null;
  }

  restore(id, now) {
    return this.db.prepare(`
      UPDATE issues SET deleted_at = NULL, updated_at = ?, revision = revision + 1
      WHERE id = ? AND deleted_at IS NOT NULL RETURNING *
    `).get(requireTimestamp(now, 'now'), requireInteger(id, 'id', { min: 1 })) || null;
  }

  search(query, { chatId, limit = 20 } = {}) {
    const maximum = requireInteger(limit, 'limit', { min: 1 });
    if (maximum > 100) throw new RangeError('limit must not exceed 100');
    const search = normalizeSearchQuery(query);
    const id = chatId == null ? null : requireInteger(chatId, 'chatId', { min: 1 });
    const chatFilter = chatId == null ? '' : 'AND i.chat_id = @chatId';
    const parameters = { chatId: id, limit: maximum };
    const likePredicate = search.likes.map((like, index) => {
      parameters[`like${index}`] = like;
      return `(
        i.title LIKE @like${index} ESCAPE '\\' COLLATE NOCASE
        OR i.description LIKE @like${index} ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (
          SELECT 1 FROM issue_replies r
          WHERE r.current_issue_id = i.id
            AND r.reply_text LIKE @like${index} ESCAPE '\\' COLLATE NOCASE
        )
      )`;
    }).join(' AND ');
    if (!search.useFts) {
      return this.db.prepare(`
        SELECT i.*, 0.0 AS rank FROM issues i
        WHERE i.deleted_at IS NULL ${chatFilter} AND ${likePredicate}
        ORDER BY i.id LIMIT @limit
      `).all(parameters);
    }
    return this.db.prepare(`
      WITH fts_matches AS (
        SELECT rowid, bm25(issue_fts) AS rank FROM issue_fts WHERE issue_fts MATCH @fts
      )
      SELECT i.*, COALESCE((SELECT rank FROM fts_matches WHERE rowid = i.id), 0.0) AS rank
      FROM issues i
      WHERE i.deleted_at IS NULL ${chatFilter}
        AND (EXISTS (SELECT 1 FROM fts_matches WHERE rowid = i.id) OR ${likePredicate})
      ORDER BY rank, i.id LIMIT @limit
    `).all({ ...parameters, fts: search.fts });
  }
}

module.exports = { EVENT_TYPES, ISSUE_STATUSES, IssueRepository };
