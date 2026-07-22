'use strict';

const { ACTIONS } = require('./permission-service');
const { ISSUE_STATUS, canTransition } = require('../domain/issue-state');

class IssueDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IssueDomainError';
    this.code = code;
  }
}

function issueSnapshot(issue) {
  if (!issue) return null;
  return {
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
  };
}

function withDurations(issue, now) {
  const waitingEnd = issue.first_replied_at ?? now;
  return {
    ...issue,
    waitingDurationMs: Math.max(0, waitingEnd - issue.created_at),
    firstResponseDurationMs: issue.first_replied_at === null
      ? null
      : Math.max(0, issue.first_replied_at - issue.created_at),
  };
}

class IssueService {
  constructor(options = {}) {
    if (!options.repositories?.issues || !options.repositories?.replyMatches
        || !options.repositories?.attachments || !options.repositories?.messages
        || typeof options.repositories.transaction !== 'function') {
      throw new TypeError('IssueService requires Task 3 repositories');
    }
    if (!options.permissionService?.authorize) {
      throw new TypeError('IssueService requires a PermissionService');
    }
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new TypeError('clock must be a function');
    }
    this.repositories = options.repositories;
    this.permissions = options.permissionService;
    this.clock = options.clock || (() => Date.now());
  }

  now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Injected clock must return a non-negative safe integer');
    }
    return value;
  }

  reason(value, fallback) {
    const reason = value == null ? fallback : value;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 10000) {
      throw new TypeError('reason must be a non-empty string no longer than 10000 characters');
    }
    return reason.trim();
  }

  principal(action, input) {
    return this.permissions.authorize(action, {
      chatJid: input.chatJid,
      actorJid: input.actorJid,
    });
  }

  replayedMutation(repository, input, principal, eventType) {
    if (!input.eventUid) return null;
    const event = repository.findEventByUid(input.eventUid);
    if (!event) return null;
    const issue = repository.findById(event.issue_id, { includeDeleted: true });
    const matches = issue
      && event.chat_id === principal.chat.id
      && event.actor_jid === principal.actorJid
      && event.event_type === eventType
      && (!input.publicId || issue.public_id === String(input.publicId).toUpperCase());
    if (!matches) throw new Error('issue event idempotency conflict');
    return { issue, event, replayed: true };
  }

  findIssue(repository, publicId, chatId, { includeDeleted = false } = {}) {
    const issue = repository.findByPublicId(publicId, { includeDeleted: true });
    if (!issue || issue.chat_id !== chatId || (!includeDeleted && issue.deleted_at !== null)) {
      throw new IssueDomainError('ISSUE_NOT_FOUND', 'Issue not found in the authorized chat');
    }
    return issue;
  }

  canonicalOwner(chatId, ownerJid) {
    if (ownerJid === null || ownerJid === undefined || ownerJid === '') return null;
    const normalized = this.permissions.normalizeJid(ownerJid, { kind: 'user' });
    if (!normalized) throw new TypeError('ownerJid must be a valid user JID');
    const owner = this.repositories.permissions.resolve(chatId, normalized);
    if (!owner || !owner.effective_roles.includes('MEMBER')) {
      throw new IssueDomainError('OWNER_NOT_MEMBER', 'Issue owner must be an enabled member');
    }
    return owner.canonical_jid;
  }

  assertTransition(issue, to, operation) {
    if (!canTransition(issue.status, to)) {
      throw new IssueDomainError(
        'ILLEGAL_TRANSITION',
        `${operation} cannot transition ${issue.public_id} from ${issue.status} to ${to}`
      );
    }
  }

  add(input) {
    return this.create(input);
  }

  create(input) {
    const principal = this.principal(ACTIONS.CREATE_ISSUE, input);
    const now = this.now();
    const ownerJid = this.canonicalOwner(principal.chat.id, input.ownerJid);
    const reason = this.reason(input.reason, 'Issue created');
    return this.repositories.transaction((tx) => tx.issues.create({
      issueUid: input.issueUid,
      eventUid: input.eventUid,
      idempotencyKey: input.idempotencyKey,
      chatId: principal.chat.id,
      title: input.title,
      description: input.description,
      status: ISSUE_STATUS.WAITING_TEVAU,
      createdByJid: principal.actorJid,
      ownerJid,
      sourceMessageId: input.sourceMessageId,
      sourceWhatsappMessageId: input.sourceWhatsappMessageId,
      sourceSnapshot: input.sourceSnapshot,
      attachmentIds: input.attachmentIds,
      reason,
      now,
    }));
  }

  update(input) {
    const principal = this.principal(ACTIONS.UPDATE_ISSUE, input);
    const changes = input.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new TypeError('changes must be an object');
    }
    const allowed = new Set(['title', 'description', 'ownerJid']);
    const keys = Object.keys(changes);
    if (!keys.length || keys.some((key) => !allowed.has(key))) {
      throw new TypeError('Only title, description, and ownerJid may be updated');
    }
    const patch = { ...changes };
    if (Object.hasOwn(patch, 'ownerJid')) {
      patch.ownerJid = this.canonicalOwner(principal.chat.id, patch.ownerJid);
    }
    const now = this.now();
    const reason = this.reason(input.reason, `Issue fields updated: ${keys.join(', ')}`);

    return this.repositories.transaction((tx) => {
      const replayed = this.replayedMutation(tx.issues, input, principal, 'UPDATED');
      if (replayed) return replayed;
      const before = this.findIssue(tx.issues, input.publicId, principal.chat.id);
      const after = tx.issues.update(before.id, patch, now);
      if (!after) throw new IssueDomainError('ISSUE_NOT_FOUND', 'Issue is unavailable');
      const event = tx.issues.appendEvent({
        eventUid: input.eventUid,
        issueId: before.id,
        eventType: 'UPDATED',
        actorJid: principal.actorJid,
        before: issueSnapshot(before),
        after: issueSnapshot(after),
        reason,
        occurredAt: now,
      });
      return { issue: after, event };
    });
  }

  resolve(input) {
    const principal = this.principal(ACTIONS.RESOLVE_ISSUE, input);
    const now = this.now();
    const reason = this.reason(input.reason ?? input.note, 'Issue verified as resolved');
    return this.repositories.transaction((tx) => {
      const replayed = this.replayedMutation(tx.issues, input, principal, 'RESOLVED');
      if (replayed) return replayed;
      const before = this.findIssue(tx.issues, input.publicId, principal.chat.id);
      this.assertTransition(before, ISSUE_STATUS.RESOLVED, 'resolve');
      const after = tx.issues.update(before.id, {
        status: ISSUE_STATUS.RESOLVED,
        resolvedAt: now,
      }, now);
      const event = tx.issues.appendEvent({
        eventUid: input.eventUid,
        issueId: before.id,
        eventType: 'RESOLVED',
        actorJid: principal.actorJid,
        before: issueSnapshot(before),
        after: issueSnapshot(after),
        reason,
        occurredAt: now,
      });
      return { issue: after, event };
    });
  }

  archive(input) {
    const principal = this.principal(ACTIONS.ARCHIVE_ISSUE, input);
    const now = this.now();
    const reason = this.reason(input.reason, 'Resolved issue archived');
    return this.repositories.transaction((tx) => {
      const replayed = this.replayedMutation(tx.issues, input, principal, 'ARCHIVED');
      if (replayed) return replayed;
      const before = this.findIssue(tx.issues, input.publicId, principal.chat.id);
      this.assertTransition(before, ISSUE_STATUS.ARCHIVED, 'archive');
      const after = tx.issues.update(before.id, {
        status: ISSUE_STATUS.ARCHIVED,
        archivedAt: now,
      }, now);
      const event = tx.issues.appendEvent({
        eventUid: input.eventUid,
        issueId: before.id,
        eventType: 'ARCHIVED',
        actorJid: principal.actorJid,
        before: issueSnapshot(before),
        after: issueSnapshot(after),
        reason,
        occurredAt: now,
      });
      return { issue: after, event };
    });
  }

  delete(input) {
    const principal = this.principal(ACTIONS.DELETE_ISSUE, input);
    const now = this.now();
    const reason = this.reason(input.reason, 'Issue soft-deleted by administrator');
    return this.repositories.transaction((tx) => {
      const replayed = this.replayedMutation(tx.issues, input, principal, 'DELETED');
      if (replayed) return replayed;
      const before = this.findIssue(tx.issues, input.publicId, principal.chat.id);
      const after = tx.issues.softDelete(before.id, now);
      const event = tx.issues.appendEvent({
        eventUid: input.eventUid,
        issueId: before.id,
        eventType: 'DELETED',
        actorJid: principal.actorJid,
        before: issueSnapshot(before),
        after: issueSnapshot(after),
        reason,
        occurredAt: now,
      });
      return { issue: after, event };
    });
  }

  restore(input) {
    const principal = this.principal(ACTIONS.RESTORE_ISSUE, input);
    const now = this.now();
    return this.repositories.transaction((tx) => {
      const replayed = this.replayedMutation(tx.issues, input, principal, 'RESTORED');
      if (replayed) return replayed;
      const before = this.findIssue(tx.issues, input.publicId, principal.chat.id, {
        includeDeleted: true,
      });
      let after;
      let fallback;
      if (before.deleted_at !== null) {
        // Restore visibility only. Lifecycle state/timestamps are intentionally
        // preserved, including ARCHIVED; reopening that state takes another call.
        after = tx.issues.restore(before.id, now);
        fallback = 'Soft-deleted issue restored with lifecycle state preserved';
      } else if (before.status === ISSUE_STATUS.ARCHIVED) {
        after = tx.issues.update(before.id, {
          status: ISSUE_STATUS.RESOLVED,
          archivedAt: null,
        }, now);
        fallback = 'Archived issue restored to RESOLVED';
      } else {
        throw new IssueDomainError(
          'NOT_RESTORABLE',
          'Only a soft-deleted or ARCHIVED issue can be restored'
        );
      }
      const event = tx.issues.appendEvent({
        eventUid: input.eventUid,
        issueId: before.id,
        eventType: 'RESTORED',
        actorJid: principal.actorJid,
        before: issueSnapshot(before),
        after: issueSnapshot(after),
        reason: this.reason(input.reason, fallback),
        occurredAt: now,
      });
      return { issue: after, event };
    });
  }

  confirmReply(input) {
    const principal = this.principal(ACTIONS.CONFIRM_REPLY, input);
    const now = this.now();
    const reason = this.reason(input.reason, 'Tevau reply confirmed by ERIC');
    const session = this.repositories.replyMatches.findByToken(input.token);
    if (!session || session.chat_id !== principal.chat.id) {
      throw new IssueDomainError('REPLY_SESSION_NOT_FOUND', 'Reply session not found in this chat');
    }

    // Expiry is a durable outcome, not part of the failed confirmation unit of
    // work. Persist it before throwing so a service-level failure cannot roll it
    // back with the reply/issue transaction.
    if (session.status === 'PENDING' && session.expires_at < now) {
      this.repositories.replyMatches.expirePending({ token: input.token, now });
      throw new IssueDomainError(
        'REPLY_CONFIRMATION_REJECTED',
        'Reply token is expired, consumed, assigned to another ERIC, or does not include this issue'
      );
    }

    const issue = this.repositories.issues.findByPublicId(input.publicId, { includeDeleted: true });
    if (!issue || issue.chat_id !== principal.chat.id || issue.deleted_at !== null) {
      throw new IssueDomainError('ISSUE_NOT_FOUND', 'Issue not found in the authorized chat');
    }
    // A consumed token is replayable only for its exact Eric/issue binding.
    // Let the repository return the original immutable result even if the issue
    // has since advanced to RESOLVED/ARCHIVED.
    if (session.status !== 'CONFIRMED'
        && ![ISSUE_STATUS.WAITING_TEVAU, ISSUE_STATUS.REPLIED].includes(issue.status)) {
      throw new IssueDomainError(
        'ILLEGAL_TRANSITION',
        `Replies cannot be confirmed for an issue in ${issue.status}`
      );
    }
    // Repository confirmation remains one atomic unit (session consumption,
    // reply insertion, issue update, and audit insertion). It is intentionally
    // not enclosed by a service transaction that could undo durable expiry.
    const result = this.repositories.replyMatches.confirm({
      token: input.token,
      ericJid: principal.actorJid,
      issueId: issue.id,
      eventUid: input.eventUid,
      replyUid: input.replyUid,
      reason,
      now,
    });
    if (!result) {
      throw new IssueDomainError(
        'REPLY_CONFIRMATION_REJECTED',
        'Reply token is expired, consumed, assigned to another ERIC, or does not include this issue'
      );
    }
    return {
      ...result,
      firstResponseDurationMs: result.issue.first_replied_at - result.issue.created_at,
    };
  }

  moveReply(input) {
    const principal = this.principal(ACTIONS.MOVE_REPLY, input);
    const now = this.now();
    const reason = this.reason(input.reason, 'Administrator corrected reply association');
    return this.repositories.transaction((tx) => {
      const replayed = this.replayedMutation(
        tx.issues,
        { ...input, publicId: input.toPublicId },
        principal,
        'REPLY_MOVED'
      );
      if (replayed) {
        const after = JSON.parse(replayed.event.after_json || '{}');
        const before = JSON.parse(replayed.event.before_json || '{}');
        const reply = tx.replyMatches.findReply(after.replyId);
        const sourceIssue = tx.issues.findById(before.issueId, { includeDeleted: true });
        if (!reply || !sourceIssue) throw new Error('replayed move-reply state is unavailable');
        return {
          reply,
          sourceIssue,
          targetIssue: replayed.issue,
          event: replayed.event,
          sourceEvent: input.sourceEventUid
            ? tx.issues.findEventByUid(input.sourceEventUid)
            : null,
          replayed: true,
        };
      }
      let reply;
      if (input.replyId !== undefined && input.replyId !== null) {
        reply = tx.replyMatches.findReply(input.replyId);
      } else if (input.fromPublicId) {
        const selectedSource = this.findIssue(
          tx.issues,
          input.fromPublicId,
          principal.chat.id
        );
        const replies = tx.issues.listReplies(selectedSource.id);
        if (replies.length !== 1) {
          throw new IssueDomainError(
            'REPLY_SELECTION_REQUIRED',
            `Source issue has ${replies.length} replies; supply reply=<numeric reply id>`
          );
        }
        [reply] = replies;
      } else {
        throw new TypeError('replyId or fromPublicId is required');
      }
      if (!reply || reply.chat_id !== principal.chat.id) {
        throw new IssueDomainError('REPLY_NOT_FOUND', 'Confirmed reply not found in this chat');
      }
      if (input.fromPublicId) {
        const expectedSource = this.findIssue(
          tx.issues,
          input.fromPublicId,
          principal.chat.id
        );
        if (reply.current_issue_id !== expectedSource.id) {
          throw new IssueDomainError('REPLY_NOT_FOUND', 'Reply is not linked to the supplied source issue');
        }
      }
      const source = tx.issues.findById(reply.current_issue_id, { includeDeleted: true });
      const target = this.findIssue(tx.issues, input.toPublicId, principal.chat.id);
      if (!source || source.deleted_at !== null
          || ![ISSUE_STATUS.REPLIED, ISSUE_STATUS.RESOLVED, ISSUE_STATUS.ARCHIVED].includes(source.status)) {
        throw new IssueDomainError(
          'ILLEGAL_MOVE',
          'Reply source must be a visible issue with a confirmed-reply lifecycle state'
        );
      }
      if (!Object.values(ISSUE_STATUS).includes(target.status)) {
        throw new IssueDomainError('ILLEGAL_MOVE', 'Reply target has an unsupported lifecycle state');
      }
      if (reply.confirmed_at < target.created_at) {
        throw new IssueDomainError('ILLEGAL_MOVE', 'Reply predates the target issue');
      }
      return tx.issues.moveReply({
        replyId: reply.id,
        toIssueId: target.id,
        actorJid: principal.actorJid,
        eventUid: input.eventUid,
        sourceEventUid: input.sourceEventUid,
        reason,
        now,
      });
    });
  }

  listOpen(input) {
    const principal = this.principal(ACTIONS.VIEW, input);
    const now = this.now();
    return this.repositories.issues.listOpen(principal.chat.id)
      .map((issue) => withDurations(issue, now))
      .sort((left, right) => (
        right.waitingDurationMs - left.waitingDurationMs
        || left.created_at - right.created_at
        || left.id - right.id
      ));
  }

  find(input) {
    const principal = this.principal(ACTIONS.VIEW, input);
    const now = this.now();
    if (input.sourceWhatsappMessageId) {
      return this.repositories.issues.findBySourceWhatsappMessageId(
        input.sourceWhatsappMessageId,
        principal.chat.id
      ).map((issue) => withDurations(issue, now));
    }
    return this.repositories.issues.search(input.query, {
      chatId: principal.chat.id,
      limit: input.limit ?? 50,
    }).map((issue) => withDurations(issue, now));
  }

  show(input) {
    const includeDeleted = input.includeDeleted === true;
    const principal = this.principal(
      includeDeleted ? ACTIONS.VIEW_DELETED : ACTIONS.VIEW,
      input
    );
    const now = this.now();
    let issue;
    if (input.publicId) {
      issue = this.findIssue(this.repositories.issues, input.publicId, principal.chat.id, {
        includeDeleted,
      });
    } else if (input.sourceWhatsappMessageId) {
      const matches = this.repositories.issues.findBySourceWhatsappMessageId(
        input.sourceWhatsappMessageId,
        principal.chat.id,
        { includeDeleted }
      );
      if (matches.length === 0) {
        throw new IssueDomainError('ISSUE_NOT_FOUND', 'No issue is linked to the quoted source');
      }
      if (matches.length > 1) {
        throw new IssueDomainError(
          'AMBIGUOUS_SOURCE',
          'The quoted source is linked to multiple issues; use a TV number'
        );
      }
      [issue] = matches;
    } else {
      throw new TypeError('publicId or sourceWhatsappMessageId is required');
    }
    return {
      issue: withDurations(issue, now),
      replies: this.repositories.issues.listReplies(issue.id),
      attachments: this.repositories.attachments.listForIssue(issue.id),
      events: this.repositories.issues.listEvents(issue.id),
      sourceMessage: issue.source_message_id
        ? this.repositories.messages.findById(issue.source_message_id)
        : null,
    };
  }

  attachmentsForRetry(input) {
    const principal = this.principal(ACTIONS.DOWNLOAD, input);
    const issue = this.findIssue(
      this.repositories.issues,
      input.publicId,
      principal.chat.id
    );
    return {
      issue,
      attachments: this.repositories.attachments.listRetryableForIssue(
        issue.id,
        input.now ?? this.now()
      ),
      chatJid: principal.chat.jid,
    };
  }

  attachmentForResend(input) {
    const principal = this.principal(ACTIONS.DOWNLOAD, input);
    const issue = this.findIssue(
      this.repositories.issues,
      input.publicId,
      principal.chat.id
    );
    const attachment = this.repositories.attachments.findById(input.attachmentId);
    if (!attachment || attachment.chat_id !== principal.chat.id
        || attachment.issue_id !== issue.id) {
      throw new IssueDomainError(
        'ATTACHMENT_NOT_FOUND',
        'Attachment not found on this issue in the authorized chat'
      );
    }
    if (!attachment.storage_key) {
      throw new IssueDomainError(
        'ATTACHMENT_UNAVAILABLE',
        'Attachment metadata exists but no archived file is available yet'
      );
    }
    return { issue, attachment };
  }
}

module.exports = {
  IssueDomainError,
  IssueService,
  issueSnapshot,
  withDurations,
};
