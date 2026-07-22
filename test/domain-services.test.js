'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { ISSUE_STATUS, RESTORE_RULES } = require('../domain/issue-state');
const {
  ACTIONS,
  AuthorizationError,
  PermissionService,
} = require('../services/permission-service');
const { IssueDomainError, IssueService } = require('../services/issue-service');

const CHAT_JID = '120300000000000000@g.us';
const OTHER_CHAT_JID = '120300000000000001@g.us';
const MEMBER_JID = '60111111111@c.us';
const MEMBER_ALIAS = 'member-one@lid';
const ERIC_JID = '60222222222@c.us';
const ERIC_ALIAS = 'eric-runtime@lid';
const ADMIN_JID = '60333333333@c.us';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-domain-service-test-'));
  const filename = path.join(root, 'db', 'test.sqlite3');
  const db = getDatabase({ filename, busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  let currentTime = 1000;
  const clock = () => currentTime;
  const setTime = (value) => { currentTime = value; };

  const chat = repositories.chats.create({
    chatUid: 'authorized-chat', jid: CHAT_JID, timezone: 'Asia/Kuala_Lumpur', now: 10,
  }).record;
  const otherChat = repositories.chats.create({
    chatUid: 'other-chat', jid: OTHER_CHAT_JID, timezone: 'Asia/Kuala_Lumpur', now: 10,
  }).record;

  const member = repositories.permissions.set({
    permissionUid: 'member', chatId: chat.id, canonicalJid: MEMBER_JID,
    role: 'MEMBER', now: 20,
  });
  repositories.permissions.addAlias({
    aliasUid: 'member-alias', permissionId: member.id, aliasJid: MEMBER_ALIAS, now: 21,
  });

  const eric = repositories.permissions.set({
    permissionUid: 'eric', chatId: chat.id, canonicalJid: ERIC_JID,
    role: 'ERIC', now: 22,
  });
  repositories.permissions.set({
    chatId: chat.id, canonicalJid: ERIC_JID, role: 'MEMBER', now: 23,
  });
  repositories.permissions.addAlias({
    aliasUid: 'eric-alias', permissionId: eric.id, aliasJid: ERIC_ALIAS, now: 24,
  });

  const admin = repositories.permissions.set({
    permissionUid: 'admin', chatId: chat.id, canonicalJid: ADMIN_JID,
    role: 'ADMIN', now: 25,
  });
  const disabled = repositories.permissions.set({
    permissionUid: 'disabled', chatId: chat.id, canonicalJid: '60444444444@c.us',
    role: 'MEMBER', now: 26,
  });
  const disabledAlias = repositories.permissions.addAlias({
    aliasUid: 'disabled-alias', permissionId: disabled.id,
    aliasJid: 'disabled@lid', now: 27,
  }).record;
  repositories.permissions.setAliasEnabled(disabledAlias.id, false, 28);
  repositories.permissions.setIdentityEnabled(disabled.id, false, 29);

  const permissions = new PermissionService({ repositories, authorizedChatJid: CHAT_JID });
  const issues = new IssueService({ repositories, permissionService: permissions, clock });
  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    admin, chat, db, eric, issues, member, otherChat, permissions, repositories, setTime,
  };
}

function issueInput(actorJid, suffix, extra = {}) {
  return {
    chatJid: CHAT_JID,
    actorJid,
    issueUid: `issue-${suffix}`,
    eventUid: `created-${suffix}`,
    idempotencyKey: `command-${suffix}`,
    title: `Issue ${suffix}`,
    description: `Description ${suffix}`,
    ...extra,
  };
}

function createSession(repositories, issue, suffix, createdAt, extra = {}) {
  return repositories.replyMatches.create({
    sessionUid: `session-${suffix}`,
    token: `TOKEN-${suffix}`,
    chatId: issue.chat_id,
    sourceWhatsappMessageId: `external-reply-${suffix}`,
    ericJid: ERIC_JID,
    replyText: `Tevau reply ${suffix}`,
    candidates: [{ issueId: issue.id, confidence: 0.9, reason: 'matching evidence' }],
    createdAt,
    expiresAt: createdAt + 10000,
    ...extra,
  }).record;
}

function errorCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

test('permission service checks the authorized enabled chat before AI/download work or identity lookup', (t) => {
  const { chat, permissions, repositories } = fixture(t);
  let effectCalls = 0;
  let identityLookups = 0;
  const originalResolve = repositories.permissions.resolve.bind(repositories.permissions);
  repositories.permissions.resolve = (...args) => {
    identityLookups += 1;
    return originalResolve(...args);
  };

  assert.throws(() => permissions.beforeAi({
    chatJid: OTHER_CHAT_JID, actorJid: MEMBER_JID,
  }, () => { effectCalls += 1; }), errorCode('CHAT_NOT_AUTHORIZED'));
  assert.throws(() => permissions.beforeDownload({
    chatJid: 'not-a-chat', actorJid: MEMBER_JID,
  }, () => { effectCalls += 1; }), errorCode('CHAT_NOT_AUTHORIZED'));
  assert.equal(effectCalls, 0);
  assert.equal(identityLookups, 0, 'cross-chat denial must happen before actor resolution');

  assert.equal(permissions.beforeAi({
    chatJid: CHAT_JID.toUpperCase(), actorJid: ` ${MEMBER_ALIAS.toUpperCase()} `,
  }, (principal) => {
    effectCalls += 1;
    assert.equal(principal.actorJid, MEMBER_JID);
    assert.equal(principal.matchedAliasJid, MEMBER_ALIAS);
    return 'AI allowed';
  }), 'AI allowed');
  assert.equal(effectCalls, 1);

  repositories.chats.setEnabled(chat.id, false, 40);
  assert.throws(() => permissions.beforeDownload({
    chatJid: CHAT_JID, actorJid: MEMBER_JID,
  }, () => { effectCalls += 1; }), errorCode('CHAT_DISABLED'));
  assert.equal(effectCalls, 1);
});

test('multi-role, alias, disabled, and exact ERIC/admin authorization rules are enforced', (t) => {
  const { permissions } = fixture(t);
  assert.equal(permissions.authorize(ACTIONS.CREATE_ISSUE, {
    chatJid: CHAT_JID, actorJid: MEMBER_ALIAS,
  }).actorJid, MEMBER_JID);
  assert.equal(permissions.authorize(ACTIONS.CONFIRM_REPLY, {
    chatJid: CHAT_JID, actorJid: ERIC_ALIAS,
  }).actorJid, ERIC_JID);
  assert.equal(permissions.authorize(ACTIONS.ARCHIVE_ISSUE, {
    chatJid: CHAT_JID, actorJid: ADMIN_JID,
  }).actorJid, ADMIN_JID);
  // ADMIN implies MEMBER but never ERIC; MEMBER and ERIC never imply ADMIN.
  assert.doesNotThrow(() => permissions.authorize(ACTIONS.UPDATE_ISSUE, {
    chatJid: CHAT_JID, actorJid: ADMIN_JID,
  }));
  assert.throws(() => permissions.authorize(ACTIONS.CONFIRM_REPLY, {
    chatJid: CHAT_JID, actorJid: ADMIN_JID,
  }), errorCode('ROLE_REQUIRED'));
  assert.throws(() => permissions.authorize(ACTIONS.DELETE_ISSUE, {
    chatJid: CHAT_JID, actorJid: ERIC_JID,
  }), errorCode('ROLE_REQUIRED'));
  for (const actorJid of ['60444444444@c.us', 'disabled@lid']) {
    assert.throws(() => permissions.authorize(ACTIONS.CREATE_ISSUE, {
      chatJid: CHAT_JID, actorJid,
    }), errorCode('ROLE_REQUIRED'));
  }
  assert.ok(AuthorizationError.prototype instanceof Error);
});

test('member create/update/resolve, ERIC replies, and admin archive follow the only legal lifecycle', (t) => {
  const { issues, repositories, setTime } = fixture(t);
  setTime(1000);
  const created = issues.create(issueInput(MEMBER_ALIAS, 'lifecycle', {
    ownerJid: MEMBER_ALIAS,
    reason: 'Customer escalation received',
  })).record;
  assert.equal(created.public_id, 'TV1');
  assert.equal(created.status, ISSUE_STATUS.WAITING_TEVAU);
  assert.equal(created.created_by_jid, MEMBER_JID);
  assert.equal(created.owner_jid, MEMBER_JID);

  setTime(1100);
  const updated = issues.update({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: 'tv1',
    changes: { title: 'Updated title', ownerJid: ERIC_ALIAS },
    reason: 'Assigned for external follow-up', eventUid: 'updated-lifecycle',
  });
  assert.equal(updated.issue.owner_jid, ERIC_JID);
  assert.throws(() => issues.resolve({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: 'TV1',
  }), errorCode('ILLEGAL_TRANSITION'));
  assert.throws(() => issues.archive({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: 'TV1',
  }), errorCode('ROLE_REQUIRED'));

  createSession(repositories, created, 'FIRST', 1150);
  assert.throws(() => issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, token: 'TOKEN-FIRST', publicId: 'TV1',
  }), errorCode('ROLE_REQUIRED'));
  setTime(1200);
  const first = issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_ALIAS, token: 'TOKEN-FIRST', publicId: 'TV1',
    eventUid: 'confirmed-first', replyUid: 'reply-first', reason: 'Eric verified source',
  });
  assert.equal(first.issue.status, ISSUE_STATUS.REPLIED);
  assert.equal(first.issue.first_replied_at, 1200);
  assert.equal(first.firstResponseDurationMs, 200);

  createSession(repositories, first.issue, 'SECOND', 1250);
  setTime(1300);
  const second = issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-SECOND', publicId: 'TV1',
    eventUid: 'confirmed-second', replyUid: 'reply-second',
  });
  assert.equal(second.issue.status, ISSUE_STATUS.REPLIED);
  assert.equal(second.issue.first_replied_at, 1200, 'additional replies must not reset first response');
  assert.equal(repositories.issues.listReplies(created.id).length, 2);

  setTime(1400);
  const resolved = issues.resolve({
    chatJid: CHAT_JID, actorJid: MEMBER_ALIAS, publicId: 'TV1',
    note: 'Merchant verified the fix', eventUid: 'resolved-lifecycle',
  });
  assert.equal(resolved.issue.status, ISSUE_STATUS.RESOLVED);
  assert.equal(resolved.issue.resolved_at, 1400);
  assert.throws(() => issues.resolve({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: 'TV1',
  }), errorCode('ILLEGAL_TRANSITION'));

  setTime(1500);
  const archived = issues.archive({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: 'TV1',
    eventUid: 'archived-lifecycle',
  });
  assert.equal(archived.issue.status, ISSUE_STATUS.ARCHIVED);
  assert.equal(archived.issue.archived_at, 1500);
  assert.throws(() => issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-SECOND', publicId: 'TV1',
  }), errorCode('ILLEGAL_TRANSITION'));

  const events = repositories.issues.listEvents(created.id);
  assert.deepEqual(events.map((event) => event.event_type), [
    'CREATED', 'UPDATED', 'REPLY_CONFIRMED', 'REPLY_CONFIRMED', 'RESOLVED', 'ARCHIVED',
  ]);
  for (const event of events) {
    assert.ok(event.actor_jid);
    assert.ok(event.reason);
    assert.ok(event.after_json);
    if (event.event_type !== 'CREATED') assert.ok(event.before_json);
  }
});

test('soft delete and the two explicit archived restore rules preserve history', (t) => {
  const { issues, repositories, setTime } = fixture(t);
  assert.match(RESTORE_RULES.DELETED_ARCHIVED, /First restore visibility/);
  setTime(1000);
  const issue = issues.create(issueInput(MEMBER_JID, 'restore')).record;
  createSession(repositories, issue, 'RESTORE', 1010);
  setTime(1020);
  issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-RESTORE', publicId: issue.public_id,
    eventUid: 'restore-confirm', replyUid: 'restore-reply',
  });
  setTime(1030);
  issues.resolve({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: issue.public_id,
    eventUid: 'restore-resolve',
  });
  setTime(1040);
  issues.archive({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: issue.public_id,
    eventUid: 'restore-archive',
  });
  setTime(1050);
  const deleted = issues.delete({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: issue.public_id,
    eventUid: 'restore-delete', reason: 'Duplicate historical ticket',
  });
  assert.equal(deleted.issue.deleted_at, 1050);
  assert.equal(repositories.issues.findByPublicId(issue.public_id), null);

  setTime(1060);
  const visible = issues.restore({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: issue.public_id,
    eventUid: 'restore-visible',
  });
  assert.equal(visible.issue.deleted_at, null);
  assert.equal(visible.issue.status, ISSUE_STATUS.ARCHIVED);
  assert.equal(visible.issue.archived_at, 1040);

  setTime(1070);
  const reopened = issues.restore({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: issue.public_id,
    eventUid: 'restore-reopen',
  });
  assert.equal(reopened.issue.status, ISSUE_STATUS.RESOLVED);
  assert.equal(reopened.issue.archived_at, null);
  assert.equal(reopened.issue.resolved_at, 1030);
  assert.equal(repositories.issues.listReplies(issue.id).length, 1);
  assert.throws(() => issues.restore({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: issue.public_id,
  }), errorCode('NOT_RESTORABLE'));
});

test('cross-chat issues and reply sessions cannot be read or mutated through the authorized chat', (t) => {
  const { issues, otherChat, repositories, setTime } = fixture(t);
  const foreignIssue = repositories.issues.create({
    issueUid: 'foreign-issue', eventUid: 'foreign-created', idempotencyKey: 'foreign-command',
    chatId: otherChat.id, title: 'Foreign', description: 'Other chat',
    createdByJid: MEMBER_JID, reason: 'Foreign seed', now: 500,
  }).record;
  repositories.permissions.set({
    permissionUid: 'foreign-member', chatId: otherChat.id,
    canonicalJid: MEMBER_JID, role: 'MEMBER', now: 501,
  });
  createSession(repositories, foreignIssue, 'FOREIGN', 510);
  setTime(600);
  assert.throws(() => issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-FOREIGN',
    publicId: foreignIssue.public_id,
  }), errorCode('REPLY_SESSION_NOT_FOUND'));
  assert.equal(repositories.replyMatches.findByToken('TOKEN-FOREIGN').status, 'PENDING');
  assert.throws(() => issues.update({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: foreignIssue.public_id,
    changes: { title: 'Cross-chat attack' },
  }), errorCode('ISSUE_NOT_FOUND'));
  assert.throws(() => issues.show({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: foreignIssue.public_id,
  }), errorCode('ISSUE_NOT_FOUND'));
  assert.throws(() => issues.create({
    ...issueInput(MEMBER_JID, 'wrong-chat'), chatJid: OTHER_CHAT_JID,
  }), errorCode('CHAT_NOT_AUTHORIZED'));
  assert.equal(repositories.issues.findByPublicId(foreignIssue.public_id).title, 'Foreign');
});

test('all service mutations roll back when append-only audit insertion fails and TV IDs remain monotonic', (t) => {
  const { db, issues, repositories, setTime } = fixture(t);
  setTime(1000);
  const stable = issues.create(issueInput(MEMBER_JID, 'stable', {
    eventUid: 'audit-collision',
  })).record;
  assert.equal(stable.public_id, 'TV1');

  setTime(1010);
  assert.throws(() => issues.create(issueInput(MEMBER_JID, 'failed-create', {
    eventUid: 'audit-collision',
  })), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT next_value FROM sequences WHERE name='issue_tv'").get().next_value, 2);
  const lifecycle = issues.create(issueInput(MEMBER_JID, 'rollback-lifecycle')).record;
  assert.equal(lifecycle.public_id, 'TV2', 'rolled-back sequence allocation must not make a gap');

  setTime(1020);
  assert.throws(() => issues.update({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: lifecycle.public_id,
    changes: { title: 'Must rollback' }, eventUid: 'audit-collision',
  }), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(repositories.issues.findByPublicId(lifecycle.public_id).title, 'Issue rollback-lifecycle');

  createSession(repositories, lifecycle, 'ROLLBACK-CONFIRM', 1021);
  setTime(1030);
  assert.throws(() => issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-ROLLBACK-CONFIRM',
    publicId: lifecycle.public_id, eventUid: 'audit-collision', replyUid: 'rollback-confirm-reply',
  }), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(repositories.replyMatches.findByToken('TOKEN-ROLLBACK-CONFIRM').status, 'PENDING');
  assert.equal(repositories.issues.findByPublicId(lifecycle.public_id).status, ISSUE_STATUS.WAITING_TEVAU);
  assert.equal(repositories.issues.listReplies(lifecycle.id).length, 0);

  setTime(1040);
  issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-ROLLBACK-CONFIRM',
    publicId: lifecycle.public_id, eventUid: 'valid-confirm', replyUid: 'valid-confirm-reply',
  });
  setTime(1050);
  assert.throws(() => issues.resolve({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: lifecycle.public_id,
    eventUid: 'audit-collision',
  }), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(repositories.issues.findByPublicId(lifecycle.public_id).status, ISSUE_STATUS.REPLIED);
  assert.equal(repositories.issues.findByPublicId(lifecycle.public_id).resolved_at, null);
  issues.resolve({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: lifecycle.public_id,
    eventUid: 'valid-resolve',
  });

  setTime(1060);
  assert.throws(() => issues.archive({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: lifecycle.public_id,
    eventUid: 'audit-collision',
  }), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(repositories.issues.findByPublicId(lifecycle.public_id).status, ISSUE_STATUS.RESOLVED);
  issues.archive({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: lifecycle.public_id,
    eventUid: 'valid-archive',
  });

  setTime(1070);
  assert.throws(() => issues.delete({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: lifecycle.public_id,
    eventUid: 'audit-collision',
  }), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(repositories.issues.findByPublicId(lifecycle.public_id).deleted_at, null);
  issues.delete({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: lifecycle.public_id,
    eventUid: 'valid-delete',
  });

  setTime(1080);
  assert.throws(() => issues.restore({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: lifecycle.public_id,
    eventUid: 'audit-collision',
  }), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(repositories.issues.findByPublicId(lifecycle.public_id, {
    includeDeleted: true,
  }).deleted_at, 1070);
  issues.restore({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, publicId: lifecycle.public_id,
    eventUid: 'valid-restore',
  });
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});

test('admin move-reply is atomic, audited on both timelines, and recomputes response state', (t) => {
  const { issues, repositories, setTime } = fixture(t);
  setTime(1000);
  const source = issues.create(issueInput(MEMBER_JID, 'move-source')).record;
  setTime(1010);
  const target = issues.create(issueInput(MEMBER_JID, 'move-target')).record;
  createSession(repositories, source, 'MOVE', 1020);
  setTime(1030);
  const confirmed = issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-MOVE',
    publicId: source.public_id, eventUid: 'move-confirmed', replyUid: 'move-reply',
  });

  setTime(1040);
  assert.throws(() => issues.moveReply({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, replyId: confirmed.reply.id,
    toPublicId: target.public_id,
  }), errorCode('ROLE_REQUIRED'));
  assert.throws(() => issues.moveReply({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, replyId: confirmed.reply.id,
    toPublicId: target.public_id, sourceEventUid: 'audit-collision-not-present',
    eventUid: 'move-confirmed',
  }), /idempotency conflict|UNIQUE constraint failed/);
  assert.equal(repositories.replyMatches.findReply(confirmed.reply.id).current_issue_id, source.id);

  const moved = issues.moveReply({
    chatJid: CHAT_JID, actorJid: ADMIN_JID, replyId: confirmed.reply.id,
    toPublicId: target.public_id, sourceEventUid: 'move-away', eventUid: 'move-into',
    reason: 'AI selected the wrong ticket',
  });
  assert.equal(moved.sourceIssue.status, ISSUE_STATUS.WAITING_TEVAU);
  assert.equal(moved.sourceIssue.first_replied_at, null);
  assert.equal(moved.targetIssue.status, ISSUE_STATUS.REPLIED);
  assert.equal(moved.targetIssue.first_replied_at, 1030);
  assert.equal(repositories.issues.listReplies(source.id).length, 0);
  assert.equal(repositories.issues.listReplies(target.id).length, 1);
  assert.equal(repositories.issues.listEvents(source.id).at(-1).event_uid, 'move-away');
  assert.equal(repositories.issues.listEvents(target.id).at(-1).event_uid, 'move-into');
  assert.equal(repositories.issues.listEvents(source.id).at(-1).reason, 'AI selected the wrong ticket');
});

test('six open issues have injected-clock durations and stable oldest-first ordering', (t) => {
  const { issues, repositories, setTime } = fixture(t);
  const created = [];
  for (let index = 0; index < 6; index += 1) {
    // Two equal timestamps prove id is the stable tie-breaker.
    setTime(1000 + Math.floor(index / 2) * 100);
    created.push(issues.create(issueInput(MEMBER_JID, `queue-${index}`)).record);
  }
  assert.deepEqual(created.map((issue) => issue.public_id), ['TV1', 'TV2', 'TV3', 'TV4', 'TV5', 'TV6']);

  createSession(repositories, created[2], 'QUEUE-REPLY', 1300);
  setTime(1400);
  issues.confirmReply({
    chatJid: CHAT_JID, actorJid: ERIC_JID, token: 'TOKEN-QUEUE-REPLY',
    publicId: created[2].public_id, eventUid: 'queue-confirm', replyUid: 'queue-reply',
  });
  setTime(2000);
  const open = issues.listOpen({ chatJid: CHAT_JID, actorJid: MEMBER_ALIAS });
  assert.equal(open.length, 6);
  assert.deepEqual(open.map((issue) => issue.public_id), ['TV1', 'TV2', 'TV3', 'TV4', 'TV5', 'TV6']);
  assert.deepEqual(open.map((issue) => issue.waitingDurationMs), [1000, 1000, 300, 900, 800, 800]);
  assert.equal(open[2].firstResponseDurationMs, 300);
  assert.equal(open[0].firstResponseDurationMs, null);
});

test('invalid clocks are rejected before domain mutation', (t) => {
  const { permissions, repositories } = fixture(t);
  const service = new IssueService({
    repositories,
    permissionService: permissions,
    clock: () => Number.NaN,
  });
  assert.throws(() => service.create(issueInput(MEMBER_JID, 'bad-clock')), /Injected clock/);
  assert.equal(repositories.issues.findByPublicId('TV1'), null);
  assert.ok(IssueDomainError.prototype instanceof Error);
});
