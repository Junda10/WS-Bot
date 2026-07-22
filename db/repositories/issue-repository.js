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
    this.sourceSnapshotByIssue = db.prepare(
      'SELECT * FROM issue_source_snapshots WHERE issue_id = ?'
    );
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
          return {
            record: existing,
            created: false,
            sourceSnapshot: this.sourceSnapshotByIssue.get(existing.id) || null,
          };
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

      let sourceSnapshot = null;
      if (input.sourceSnapshot) {
        const snapshot = input.sourceSnapshot;
        const commandMessageId = requireInteger(
          snapshot.commandMessageId,
          'sourceSnapshot.commandMessageId',
          { min: 1 }
        );
        const command = this.messageById.get(commandMessageId);
        if (!command || command.chat_id !== values.chatId) {
          throw new Error('Source snapshot command message is unavailable or cross-chat');
        }
        const snapshotSourceId = snapshot.sourceMessageId == null
          ? null
          : requireInteger(snapshot.sourceMessageId, 'sourceSnapshot.sourceMessageId', { min: 1 });
        if (snapshotSourceId !== values.sourceMessageId) {
          throw new Error('Source snapshot message does not match issue source');
        }
        const uncertainties = Array.isArray(snapshot.uncertainties)
          ? snapshot.uncertainties.map((entry) => String(entry).slice(0, 1000))
          : [];
        sourceSnapshot = this.db.prepare(`
          INSERT INTO issue_source_snapshots (
            issue_id, chat_id, command_message_id, command_whatsapp_message_id,
            source_message_id, source_whatsapp_message_id, source_body,
            source_sender_jid, source_sent_at, source_media_json,
            extraction_status, ai_model, ai_attempts, ai_error_code,
            ai_error_message, uncertainties_json, source_summary, created_at
          ) VALUES (
            @issueId, @chatId, @commandMessageId, @commandWhatsappMessageId,
            @sourceMessageId, @sourceWhatsappMessageId, @sourceBody,
            @sourceSenderJid, @sourceSentAt, @sourceMediaJson,
            @extractionStatus, @aiModel, @aiAttempts, @aiErrorCode,
            @aiErrorMessage, @uncertaintiesJson, @sourceSummary, @createdAt
          ) RETURNING *
        `).get({
          issueId: issue.id,
          chatId: values.chatId,
          commandMessageId,
          commandWhatsappMessageId: requireString(
            snapshot.commandWhatsappMessageId,
            'sourceSnapshot.commandWhatsappMessageId',
            { max: 500 }
          ),
          sourceMessageId: values.sourceMessageId,
          sourceWhatsappMessageId: requireString(
            snapshot.sourceWhatsappMessageId,
            'sourceSnapshot.sourceWhatsappMessageId',
            { max: 500 }
          ),
          sourceBody: snapshot.sourceBody == null ? null : String(snapshot.sourceBody).slice(0, 1000000),
          sourceSenderJid: optionalString(snapshot.sourceSenderJid, 'sourceSnapshot.sourceSenderJid', { max: 200 }),
          sourceSentAt: snapshot.sourceSentAt == null
            ? null : requireTimestamp(snapshot.sourceSentAt, 'sourceSnapshot.sourceSentAt'),
          sourceMediaJson: snapshot.sourceMedia == null ? null : JSON.stringify(snapshot.sourceMedia),
          extractionStatus: enumValue(
            snapshot.extractionStatus,
            'sourceSnapshot.extractionStatus',
            new Set(['AI_VALID', 'FALLBACK'])
          ),
          aiModel: optionalString(snapshot.aiModel, 'sourceSnapshot.aiModel', { max: 300 }),
          aiAttempts: requireInteger(snapshot.aiAttempts ?? 0, 'sourceSnapshot.aiAttempts'),
          aiErrorCode: optionalString(snapshot.aiErrorCode, 'sourceSnapshot.aiErrorCode', { max: 100 }),
          aiErrorMessage: snapshot.aiErrorMessage == null
            ? null : String(snapshot.aiErrorMessage).slice(0, 2000),
          uncertaintiesJson: JSON.stringify(uncertainties),
          sourceSummary: snapshot.sourceSummary == null
            ? null : String(snapshot.sourceSummary).slice(0, 10000),
          createdAt: values.now,
        });
      }

      const attachmentIds = [...new Set(input.attachmentIds || [])];
      if (attachmentIds.length > 10) throw new RangeError('At most 10 source attachments may be linked');
      for (const rawAttachmentId of attachmentIds) {
        const attachmentId = requireInteger(rawAttachmentId, 'attachmentId', { min: 1 });
        const linked = this.db.prepare(`
          UPDATE attachments
          SET issue_id = @issueId, issue_chat_id = @chatId,
              retention_class = 'ISSUE', updated_at = @now
          WHERE id = @attachmentId AND chat_id = @chatId AND deleted_at IS NULL
            AND (issue_id IS NULL OR issue_id = @issueId)
          RETURNING blob_sha256
        `).get({ attachmentId, issueId: issue.id, chatId: values.chatId, now: values.now });
        if (!linked) throw new Error('Source attachment is unavailable, cross-chat, or already linked');
        if (linked.blob_sha256) {
          this.db.prepare(`
            UPDATE attachment_blobs SET retention_class = 'ISSUE', updated_at = @now
            WHERE sha256 = @sha256
          `).run({ sha256: linked.blob_sha256, now: values.now });
        }
      }
      return { record: issue, created: true, sourceSnapshot, attachmentIds };
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

  findByIdempotencyKey(idempotencyKey, { includeDeleted = true } = {}) {
    const row = this.byIdempotencyKey.get(
      requireString(idempotencyKey, 'idempotencyKey', { max: 500 })
    ) || null;
    return includeDeleted || !row || row.deleted_at === null ? row : null;
  }

  findSourceSnapshot(issueId) {
    return this.sourceSnapshotByIssue.get(
      requireInteger(issueId, 'issueId', { min: 1 })
    ) || null;
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

  listReportEvents(chatId, start, end) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const windowStart = requireTimestamp(start, 'start');
    const windowEnd = requireTimestamp(end, 'end');
    if (windowEnd <= windowStart) throw new RangeError('end must be greater than start');
    // Mutable issue rows are intentionally absent. Labels and lifecycle state
    // come from the latest audit snapshot at or before each event, so a later
    // update/delete cannot rewrite an earlier report.
    return this.db.prepare(`
      SELECT e.*,
        (SELECT json_extract(h.after_json, '$.publicId')
         FROM issue_events h
         WHERE h.issue_id = e.issue_id
           AND (h.occurred_at < e.occurred_at
             OR (h.occurred_at = e.occurred_at AND h.id <= e.id))
           AND json_type(h.after_json, '$.publicId') IS NOT NULL
         ORDER BY h.occurred_at DESC, h.id DESC LIMIT 1) AS historical_public_id,
        (SELECT json_extract(h.after_json, '$.title')
         FROM issue_events h
         WHERE h.issue_id = e.issue_id
           AND (h.occurred_at < e.occurred_at
             OR (h.occurred_at = e.occurred_at AND h.id <= e.id))
           AND json_type(h.after_json, '$.title') IS NOT NULL
         ORDER BY h.occurred_at DESC, h.id DESC LIMIT 1) AS historical_title,
        (SELECT json_extract(h.after_json, '$.status')
         FROM issue_events h
         WHERE h.issue_id = e.issue_id
           AND (h.occurred_at < e.occurred_at
             OR (h.occurred_at = e.occurred_at AND h.id <= e.id))
           AND json_type(h.after_json, '$.status') IS NOT NULL
         ORDER BY h.occurred_at DESC, h.id DESC LIMIT 1) AS historical_status
      FROM issue_events e
      WHERE e.chat_id = @chatId AND e.occurred_at >= @windowStart
        AND e.occurred_at < @windowEnd
        AND e.event_type IN (
          'CREATED', 'REPLY_CONFIRMED', 'RESOLVED', 'ARCHIVED',
          'DELETED', 'RESTORED', 'UPDATED'
        )
      ORDER BY e.occurred_at, e.id
    `).all({ chatId: id, windowStart, windowEnd });
  }

  historicalReportStats(chatId, start, end) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const windowStart = requireTimestamp(start, 'start');
    const windowEnd = requireTimestamp(end, 'end');
    if (windowEnd <= windowStart) throw new RangeError('end must be greater than start');
    const counts = this.db.prepare(`
      SELECT
        count(DISTINCT CASE WHEN event_type = 'CREATED' THEN issue_id END) AS created_issue_count,
        count(DISTINCT CASE WHEN event_type = 'REPLY_CONFIRMED' THEN issue_id END) AS replied_issue_count,
        count(CASE WHEN event_type = 'REPLY_CONFIRMED' THEN 1 END) AS reply_event_count,
        count(DISTINCT CASE WHEN event_type = 'RESOLVED' THEN issue_id END) AS resolved_issue_count
      FROM issue_events
      WHERE chat_id = @chatId AND occurred_at >= @windowStart AND occurred_at < @windowEnd
    `).get({ chatId: id, windowStart, windowEnd });
    const unresolvedAtEnd = this.db.prepare(`
      WITH historical_issues AS (
        SELECT DISTINCT issue_id
        FROM issue_events
        WHERE chat_id = @chatId AND occurred_at < @windowEnd
      ), states AS (
        SELECT issue_id,
          (SELECT json_extract(e.after_json, '$.status')
           FROM issue_events e
           WHERE e.issue_id = historical_issues.issue_id AND e.chat_id = @chatId
             AND e.occurred_at < @windowEnd
             AND json_type(e.after_json, '$.status') IS NOT NULL
           ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS status,
          (SELECT json_extract(e.after_json, '$.deletedAt')
           FROM issue_events e
           WHERE e.issue_id = historical_issues.issue_id AND e.chat_id = @chatId
             AND e.occurred_at < @windowEnd
             AND json_type(e.after_json, '$.deletedAt') IS NOT NULL
           ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS deleted_at
        FROM historical_issues
      )
      SELECT count(*) AS count FROM states
      WHERE status IN ('WAITING_TEVAU', 'REPLIED') AND deleted_at IS NULL
    `).get({ chatId: id, windowEnd }).count;
    return { ...counts, unresolved_at_end_issue_count: unresolvedAtEnd };
  }

  listCurrentReportIssues(chatId) {
    return this.db.prepare(`
      SELECT i.*,
        count(a.id) AS attachment_count,
        COALESCE(sum(CASE WHEN a.id IS NOT NULL AND (
          a.processing_status IN ('PENDING', 'PROCESSING')
          OR a.parse_status IN ('PENDING', 'PARSING', 'NEEDS_OCR')
        ) THEN 1 ELSE 0 END), 0) AS attachment_parse_pending_count,
        COALESCE(sum(CASE WHEN a.id IS NOT NULL AND (
          a.processing_status = 'FAILED' OR a.parse_status = 'FAILED'
        ) THEN 1 ELSE 0 END), 0) AS attachment_parse_failed_count,
        COALESCE(sum(CASE WHEN a.parse_status = 'SAVED_UNPARSED'
          THEN 1 ELSE 0 END), 0) AS attachment_saved_unparsed_count,
        s.extraction_status AS source_extraction_status,
        s.ai_error_code AS source_ai_error_code,
        s.ai_error_message AS source_ai_error_message,
        s.uncertainties_json AS source_uncertainties_json
      FROM issues i
      LEFT JOIN attachments a ON a.issue_id = i.id AND a.deleted_at IS NULL
      LEFT JOIN issue_source_snapshots s ON s.issue_id = i.id
      WHERE i.chat_id = ? AND i.deleted_at IS NULL
        AND i.status IN ('WAITING_TEVAU', 'REPLIED')
      GROUP BY i.id
      ORDER BY i.id
    `).all(requireInteger(chatId, 'chatId', { min: 1 }));
  }

  // Bounded read models for deterministic AI shortlisting. These deliberately
  // avoid listOpen(), which may grow without bound, and never return records to
  // the model directly; CandidateShortlistService compacts the selected rows.
  searchOpenCandidates(terms, { chatId, limit = 40 } = {}) {
    if (!Array.isArray(terms) || terms.length === 0 || terms.length > 16) {
      throw new TypeError('terms must contain 1..16 search terms');
    }
    const normalized = [...new Set(terms.map((term, index) => {
      const text = requireString(term, `terms[${index}]`, { max: 100 }).trim();
      if (Array.from(text).length < 3) throw new TypeError('FTS candidate terms must have 3+ characters');
      return text;
    }))];
    const maximum = requireInteger(limit, 'limit', { min: 1 });
    if (maximum > 100) throw new RangeError('limit must not exceed 100');
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const fts = normalized.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    return this.db.prepare(`
      WITH matches AS (
        SELECT rowid, bm25(issue_fts) AS rank
        FROM issue_fts
        WHERE issue_fts MATCH @fts
      )
      SELECT i.*, matches.rank AS rank
      FROM matches
      JOIN issues i ON i.id = matches.rowid
      WHERE i.chat_id = @chatId AND i.deleted_at IS NULL
        AND i.status IN ('WAITING_TEVAU', 'REPLIED')
      ORDER BY matches.rank, i.updated_at DESC, i.id
      LIMIT @limit
    `).all({ fts, chatId: id, limit: maximum });
  }

  listRecentOpenCandidates(chatId, { limit = 40 } = {}) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const maximum = requireInteger(limit, 'limit', { min: 1 });
    if (maximum > 100) throw new RangeError('limit must not exceed 100');
    return this.db.prepare(`
      SELECT i.*, NULL AS rank
      FROM issues i
      WHERE i.chat_id = ? AND i.deleted_at IS NULL
        AND i.status IN ('WAITING_TEVAU', 'REPLIED')
      ORDER BY i.updated_at DESC, i.id DESC
      LIMIT ?
    `).all(id, maximum);
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
