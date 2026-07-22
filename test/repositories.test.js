'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-repository-test-'));
  const filename = path.join(root, 'db', 'test.sqlite3');
  const db = getDatabase({ filename, busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, repositories };
}

function seedChat(repositories, suffix = 'one', now = 1000) {
  return repositories.chats.create({
    chatUid: `chat-uid-${suffix}`,
    jid: `12030000000000000${suffix === 'one' ? '0' : '1'}@g.us`,
    timezone: 'Asia/Kuala_Lumpur',
    now,
  }).record;
}

function seedMessage(repositories, chatId, suffix = '1', now = 1100, extra = {}) {
  return repositories.messages.create({
    messageUid: `message-uid-${suffix}`,
    whatsappMessageId: `wa-message-${suffix}`,
    chatId,
    senderJid: '60111111111@c.us',
    body: `message ${suffix}`,
    sentAt: now,
    receivedAt: now + 1,
    ...extra,
  }).record;
}

function seedIssue(repositories, chatId, suffix = '1', now = 1200, extra = {}) {
  return repositories.issues.create({
    issueUid: `issue-uid-${suffix}`,
    eventUid: `event-created-${suffix}`,
    idempotencyKey: `issue-command-${suffix}`,
    chatId,
    title: `Login problem ${suffix}`,
    description: `Merchant cannot log in ${suffix}`,
    createdByJid: '60222222222@c.us',
    now,
    ...extra,
  }).record;
}

function createReplySession(repositories, chatId, message, issue, suffix, replyText, now = 2300) {
  return repositories.replyMatches.create({
    sessionUid: `session-${suffix}`,
    token: `TOKEN-${suffix}`,
    chatId,
    sourceMessageId: message?.id,
    sourceWhatsappMessageId: message?.whatsapp_message_id || `external-${suffix}`,
    ericJid: '601@c.us',
    replyText,
    candidates: [{ issueId: issue.id, confidence: 0.9, reason: 'best match' }],
    createdAt: now,
    expiresAt: now + 1000,
  });
}

test('domain migration creates strict tables, composite-reference indexes, guards, and trigram FTS', (t) => {
  const { db } = fixture(t);
  const expectedTables = [
    'attachment_processing_attempts', 'attachments', 'chats', 'issue_events',
    'issue_replies', 'issue_source_snapshots', 'issues', 'jid_aliases', 'messages', 'permission_roles',
    'permissions', 'reply_match_candidates', 'reply_match_sessions', 'sequences',
    'summary_run_coverage', 'summary_run_parts', 'summary_runs',
  ];
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
  for (const table of expectedTables) assert.ok(tables.includes(table), `${table} should exist`);
  assert.ok(tables.includes('issue_fts'));
  assert.equal(db.pragma('user_version', { simple: true }), 11);
  assert.ok(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='index' AND name='issue_events_chat_time_idx'"
  ).get());
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(
    db.prepare("SELECT name, next_value, updated_at FROM sequences WHERE name='issue_tv'").get(),
    { name: 'issue_tv', next_value: 1, updated_at: 0 }
  );
  for (const trigger of [
    'issue_replies_fts_insert', 'issue_replies_fts_move',
    'issue_events_append_only_update', 'summary_parts_insert_guard',
    'messages_processing_state_update_guard', 'messages_quoted_evidence_immutable',
    'issue_source_snapshots_immutable_update',
  ]) {
    assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?"
    ).get(trigger), `${trigger} should exist`);
  }
  const ftsSql = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='issue_fts'"
  ).get().sql;
  assert.match(ftsSql, /trigram/i);
});

test('schema and repositories reject invalid timestamps, states, lengths, and orphan foreign keys', (t) => {
  const { db, repositories } = fixture(t);
  assert.throws(() => repositories.chats.create({
    jid: 'x@g.us', timezone: 'UTC', now: 1.5,
  }), /safe integer/);
  const chat = seedChat(repositories);
  assert.throws(() => db.prepare(`
    INSERT INTO messages (
      message_uid, whatsapp_message_id, chat_id, sender_jid, sent_at,
      received_at, created_at
    ) VALUES ('bad-time', 'bad-time', ?, 'x@c.us', 1.5, 2, 2)
  `).run(chat.id), /CHECK constraint failed|cannot store REAL/);
  assert.throws(() => db.prepare(`
    INSERT INTO issues (
      issue_uid, sequence_number, public_id, chat_id, title, description,
      status, created_by_jid, created_at, updated_at
    ) VALUES ('bad-state', 99, 'TV99', ?, 'x', '', 'OPEN', 'x@c.us', 1, 1)
  `).run(chat.id), /CHECK constraint failed/);
  assert.throws(() => repositories.messages.create({
    whatsappMessageId: 'orphan', chatId: 99999, senderJid: 'x@c.us',
    sentAt: 1, receivedAt: 1,
  }), /FOREIGN KEY constraint failed/);
  const issue = seedIssue(repositories, chat.id, 'long', 2000);
  assert.throws(() => repositories.issues.update(
    issue.id, { description: 'x'.repeat(1000001) }, 2100
  ), /too long/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('permissions model multi-role identities, ADMIN membership implication, and no ERIC implication', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  const eric = repositories.permissions.set({
    permissionUid: 'identity-eric', chatId: chat.id,
    canonicalJid: '601@c.us', role: 'ERIC', now: 1100,
  });
  const sameIdentity = repositories.permissions.set({
    chatId: chat.id, canonicalJid: '601@c.us', role: 'ADMIN', now: 1101,
  });
  assert.equal(sameIdentity.id, eric.id);
  assert.deepEqual(sameIdentity.roles, ['ERIC', 'ADMIN']);
  assert.deepEqual(new Set(sameIdentity.effective_roles), new Set(['MEMBER', 'ERIC', 'ADMIN']));

  const admin = repositories.permissions.set({
    permissionUid: 'identity-admin', chatId: chat.id,
    canonicalJid: '602@c.us', role: 'ADMIN', now: 1102,
  });
  assert.equal(repositories.permissions.hasRole(chat.id, '602@c.us', 'MEMBER'), true);
  assert.equal(repositories.permissions.hasRole(chat.id, '602@c.us', 'ADMIN'), true);
  assert.equal(repositories.permissions.hasRole(chat.id, '602@c.us', 'ERIC'), false);
  assert.deepEqual(admin.roles, ['ADMIN']);

  repositories.permissions.setRoleEnabled({
    permissionId: eric.id, role: 'ERIC', enabled: false, now: 1110,
  });
  const resolved = repositories.permissions.resolve(chat.id, '601@c.us');
  assert.deepEqual(resolved.roles, ['ADMIN']);
  assert.equal(repositories.permissions.hasRole(chat.id, '601@c.us', 'ERIC'), false);
});

test('disabled identities and aliases never authorize; aliases are chat-scoped', (t) => {
  const { repositories } = fixture(t);
  const chatOne = seedChat(repositories, 'one');
  const chatTwo = seedChat(repositories, 'two', 1001);
  const first = repositories.permissions.set({
    permissionUid: 'first-member', chatId: chatOne.id,
    canonicalJid: '601@c.us', role: 'MEMBER', now: 1100,
  });
  const aliasOne = repositories.permissions.addAlias({
    aliasUid: 'alias-one', permissionId: first.id, aliasJid: 'same@lid', now: 1101,
  }).record;
  const second = repositories.permissions.set({
    permissionUid: 'second-member', chatId: chatTwo.id,
    canonicalJid: '602@c.us', role: 'ADMIN', now: 1102,
  });
  repositories.permissions.addAlias({
    aliasUid: 'alias-two', permissionId: second.id, aliasJid: 'same@lid', now: 1103,
  });
  assert.equal(repositories.permissions.resolve(chatOne.id, 'same@lid').id, first.id);
  assert.equal(repositories.permissions.resolve(chatTwo.id, 'same@lid').id, second.id);

  repositories.permissions.setAliasEnabled(aliasOne.id, false, 1110);
  assert.equal(repositories.permissions.resolve(chatOne.id, 'same@lid'), null);
  assert.equal(repositories.permissions.resolve(chatOne.id, '601@c.us').id, first.id);
  repositories.permissions.setIdentityEnabled(first.id, false, 1111);
  assert.equal(repositories.permissions.resolve(chatOne.id, '601@c.us'), null);
  assert.equal(repositories.permissions.hasRole(chatOne.id, '601@c.us', 'MEMBER'), false);

  repositories.permissions.setIdentityEnabled(first.id, true, 1112);
  repositories.permissions.setAliasEnabled(aliasOne.id, true, 1113);
  assert.equal(repositories.permissions.resolve(chatOne.id, 'same@lid').id, first.id);
  assert.throws(() => repositories.permissions.set({
    chatId: chatOne.id, canonicalJid: 'same@lid', role: 'MEMBER', now: 1114,
  }), /assigned as an alias/);
  assert.throws(() => repositories.permissions.addAlias({
    permissionId: first.id, aliasJid: '601@c.us', now: 1115,
  }), /canonical JID/);

  repositories.permissions.softDelete(first.id, 1120);
  assert.equal(repositories.permissions.resolve(chatOne.id, 'same@lid'), null);
  assert.equal(repositories.permissions.resolve(chatOne.id, '601@c.us'), null);
});

test('message repository persists sender display names and filters blank rows before recent LIMIT', (t) => {
  const { db, repositories } = fixture(t);
  const chat = seedChat(repositories);
  seedMessage(repositories, chat.id, 'visible-old', 2000, {
    senderDisplayName: '小明', body: 'older visible',
  });
  seedMessage(repositories, chat.id, 'visible-new', 2001, { body: 'newer visible' });
  seedMessage(repositories, chat.id, 'blank-one', 2002, { body: '' });
  seedMessage(repositories, chat.id, 'blank-two', 2003, { body: ' \t\r\n ' });
  seedMessage(repositories, chat.id, 'blank-unicode', 2004, { body: '\u00a0\u3000' });

  const rows = repositories.messages.listRecent(chat.id, { limit: 2 });
  assert.deepEqual(rows.map((row) => row.body), ['older visible', 'newer visible']);
  assert.equal(rows[0].sender_display_name, '小明');
  assert.throws(() => seedMessage(repositories, chat.id, 'bad-display', 2004, {
    senderDisplayName: ' ',
  }), /senderDisplayName/);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});

test('message repository is idempotent, derives immutable quote snapshots, and enforces same-chat quotes', (t) => {
  const { db, repositories } = fixture(t);
  const chatOne = seedChat(repositories, 'one');
  const chatTwo = seedChat(repositories, 'two', 1001);
  const quoted = seedMessage(repositories, chatOne.id, 'quoted', 2000);
  const quotedMedia = {
    type: 'document', mimeType: 'application/pdf', fileName: 'proof.pdf',
    sizeBytes: 91, width: null, height: null, durationSeconds: null,
    pageCount: 2, isViewOnce: false,
  };
  const reply = seedMessage(repositories, chatOne.id, 'reply', 2100, {
    quotedMessageId: quoted.id,
    quotedBody: 'immutable quoted evidence',
    quotedSenderJid: '60999999999@c.us',
    quotedSentAt: 1999,
    quotedMedia,
  });
  assert.equal(reply.quoted_whatsapp_message_id, quoted.whatsapp_message_id);
  assert.equal(reply.quoted_message_chat_id, chatOne.id);
  assert.equal(reply.quoted_body, 'immutable quoted evidence');
  assert.equal(reply.quoted_sender_jid, '60999999999@c.us');
  assert.equal(reply.quoted_sent_at, 1999);
  assert.deepEqual(JSON.parse(reply.quoted_media_json), quotedMedia);
  assert.throws(() => db.prepare(
    'UPDATE messages SET quoted_whatsapp_message_id = ? WHERE id = ?'
  ).run('changed', reply.id), /immutable/);
  assert.throws(() => db.prepare(
    'UPDATE messages SET quoted_body = ? WHERE id = ?'
  ).run('rewritten evidence', reply.id), /immutable/);

  const other = seedMessage(repositories, chatTwo.id, 'other-chat', 2200);
  assert.throws(() => seedMessage(repositories, chatOne.id, 'cross-quote', 2300, {
    quotedMessageId: other.id,
  }), /different chat/);
  assert.throws(() => seedMessage(repositories, chatOne.id, 'wrong-snapshot', 2300, {
    quotedMessageId: quoted.id,
    quotedWhatsappMessageId: 'forged',
  }), /does not match/);

  const duplicate = repositories.messages.create({
    whatsappMessageId: quoted.whatsapp_message_id,
    chatId: chatOne.id, senderJid: quoted.sender_jid,
    body: 'different delivery body', sentAt: quoted.sent_at, receivedAt: 9999,
  });
  assert.equal(duplicate.created, false);
  assert.throws(() => repositories.messages.create({
    whatsappMessageId: quoted.whatsapp_message_id,
    chatId: chatOne.id, senderJid: 'attacker@c.us',
    sentAt: quoted.sent_at, receivedAt: 9999,
  }), /idempotency conflict/);

  db.prepare('DELETE FROM messages WHERE id = ?').run(quoted.id);
  const retained = repositories.messages.findById(reply.id);
  assert.equal(retained.quoted_message_id, null);
  assert.equal(retained.quoted_whatsapp_message_id, 'wa-message-quoted');
  repositories.messages.tombstone(reply.id, 3000);
  assert.equal(repositories.messages.findByWhatsappId(reply.whatsapp_message_id, {
    includeTombstone: false,
  }), null);
});

test('message processing claims are atomic, retryable, lease-aware, and ownership guarded', (t) => {
  const { db, repositories } = fixture(t);
  const chat = seedChat(repositories);
  const message = seedMessage(repositories, chat.id, 'processing', 2000);
  assert.equal(message.processing_status, 'PENDING');
  assert.equal(message.processing_attempt_count, 0);

  const first = repositories.messages.claimProcessing(message.id, {
    claimId: 'claim-one', now: 2100, leaseMs: 100,
  });
  assert.equal(first.processing_status, 'PROCESSING');
  assert.equal(first.processing_attempt_count, 1);
  assert.equal(first.processing_lease_expires_at, 2200);
  assert.equal(repositories.messages.claimProcessing(message.id, {
    claimId: 'claim-concurrent', now: 2199, leaseMs: 100,
  }), null, 'a live lease must exclude a concurrent route');
  assert.equal(repositories.messages.markProcessed(message.id, 'wrong-owner', 2150), null);

  const stale = repositories.messages.claimProcessing(message.id, {
    claimId: 'claim-stale-recovery', now: 2200, leaseMs: 100,
  });
  assert.equal(stale.processing_attempt_count, 2);
  assert.equal(repositories.messages.markFailed(
    message.id, stale.processing_claim_id, new Error('temporary route failure'), 2250
  ).processing_status, 'FAILED');

  const retry = repositories.messages.claimProcessing(message.id, {
    claimId: 'claim-retry', now: 2251, leaseMs: 100,
  });
  assert.equal(retry.processing_attempt_count, 3);
  const processed = repositories.messages.markProcessed(message.id, 'claim-retry', 2260);
  assert.equal(processed.processing_status, 'PROCESSED');
  assert.equal(processed.processing_completed_at, 2260);
  assert.equal(processed.processing_last_error, null);
  assert.equal(repositories.messages.claimProcessing(message.id, {
    claimId: 'claim-after-success', now: 9999, leaseMs: 100,
  }), null);
  assert.throws(() => db.prepare(
    "UPDATE messages SET processing_status='PROCESSING' WHERE id=?"
  ).run(message.id), /invalid message processing state/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('issue creation is transactional and TV sequence never reuses deleted or rolled-back numbers', (t) => {
  const { db, repositories } = fixture(t);
  const chat = seedChat(repositories);
  const first = seedIssue(repositories, chat.id, 'one', 2000);
  assert.equal(first.public_id, 'TV1');
  const duplicate = repositories.issues.create({
    issueUid: 'different-uid', eventUid: 'different-event',
    idempotencyKey: 'issue-command-one', chatId: chat.id,
    title: 'Login problem one', description: 'Merchant cannot log in one',
    createdByJid: '60222222222@c.us', now: 2100,
  });
  assert.equal(duplicate.created, false);
  repositories.issues.softDelete(first.id, 2200);
  const second = seedIssue(repositories, chat.id, 'two', 2300);
  assert.equal(second.public_id, 'TV2');
  assert.throws(() => repositories.transaction(() => {
    seedIssue(repositories, chat.id, 'rolled-back', 2400);
    throw new Error('force rollback');
  }), /force rollback/);
  assert.equal(db.prepare("SELECT next_value FROM sequences WHERE name='issue_tv'").get().next_value, 3);
  assert.equal(seedIssue(repositories, chat.id, 'three', 2500).public_id, 'TV3');
});

test('issue and event sources derive immutable snapshots and survive message retention purge', (t) => {
  const { db, repositories } = fixture(t);
  const chat = seedChat(repositories);
  const source = seedMessage(repositories, chat.id, 'issue-source', 2000);
  const issue = seedIssue(repositories, chat.id, 'source', 2100, {
    sourceMessageId: source.id,
  });
  assert.equal(issue.source_whatsapp_message_id, source.whatsapp_message_id);
  const created = repositories.issues.listEvents(issue.id)[0];
  assert.equal(created.source_whatsapp_message_id, source.whatsapp_message_id);
  assert.throws(() => db.prepare(
    'UPDATE issues SET source_whatsapp_message_id = ? WHERE id = ?'
  ).run('forged', issue.id), /immutable/);
  assert.throws(() => db.prepare(
    'UPDATE issue_events SET actor_jid = ? WHERE id = ?'
  ).run('forged@c.us', created.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM issue_events WHERE id = ?').run(created.id), /append-only/);
  assert.throws(() => seedIssue(repositories, chat.id, 'mismatch', 2200, {
    sourceMessageId: source.id,
    sourceWhatsappMessageId: 'forged',
  }), /does not match/);

  db.prepare('DELETE FROM messages WHERE id = ?').run(source.id);
  const retainedIssue = repositories.issues.findByPublicId(issue.public_id);
  const retainedEvent = repositories.issues.listEvents(issue.id)[0];
  assert.equal(retainedIssue.source_message_id, null);
  assert.equal(retainedIssue.source_whatsapp_message_id, 'wa-message-issue-source');
  assert.equal(retainedEvent.source_message_id, null);
  assert.equal(retainedEvent.source_whatsapp_message_id, 'wa-message-issue-source');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('atomic reply confirmation consumes token, stores reply, updates issue/audit/FTS, and is one-time', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  const issue = seedIssue(repositories, chat.id, 'confirm', 2000, {
    title: '支付登录失败',
    description: '商户结算回调持续延迟',
  });
  const source = seedMessage(repositories, chat.id, 'confirm-reply', 2100);
  createReplySession(
    repositories, chat.id, source, issue, 'CONFIRM', '权限配置修复完成，请重试登录', 2200
  );
  assert.equal(repositories.issues.search('配置修复', { chatId: chat.id }).length, 0);
  const result = repositories.replyMatches.confirm({
    token: 'TOKEN-CONFIRM', ericJid: '601@c.us', issueId: issue.id,
    eventUid: 'event-confirm', replyUid: 'reply-confirm', now: 2300,
  });
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.reply.reply_text, '权限配置修复完成，请重试登录');
  assert.equal(result.issue.status, 'REPLIED');
  assert.equal(result.issue.first_replied_at, 2300);
  assert.equal(result.event.event_type, 'REPLY_CONFIRMED');
  assert.equal(repositories.issues.listReplies(issue.id).length, 1);
  assert.equal(repositories.issues.search('登录', { chatId: chat.id }).length, 1);
  assert.equal(repositories.issues.search('结算回', { chatId: chat.id }).length, 1);
  assert.equal(repositories.issues.search('配置修', { chatId: chat.id }).length, 1);
  const replayed = repositories.replyMatches.confirm({
    token: 'TOKEN-CONFIRM', ericJid: '601@c.us', issueId: issue.id,
    eventUid: 'ignored-on-replay', replyUid: 'ignored-on-replay', now: 2400,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.reply.id, result.reply.id);
  assert.equal(repositories.issues.listReplies(issue.id).length, 1);
  assert.throws(() => repositories.issues.appendEvent({
    eventUid: 'unsafe-confirm', issueId: issue.id, eventType: 'REPLY_CONFIRMED',
    actorJid: '601@c.us', replyText: 'unsafe', occurredAt: 2400,
  }), /must use replyMatches\.confirm/);
});

test('reply confirmation failure rolls back token, durable reply, issue state, audit, and FTS', (t) => {
  const { db, repositories } = fixture(t);
  const chat = seedChat(repositories);
  const collisionIssue = seedIssue(repositories, chat.id, 'collision', 1900);
  repositories.issues.appendEvent({
    eventUid: 'event-collision', issueId: collisionIssue.id,
    eventType: 'UPDATED', actorJid: 'admin@c.us', occurredAt: 1950,
  });
  const issue = seedIssue(repositories, chat.id, 'rollback-confirm', 2000);
  const source = seedMessage(repositories, chat.id, 'rollback-confirm', 2100);
  createReplySession(
    repositories, chat.id, source, issue, 'ROLLBACK', 'atomicrollbackkeyword 原子回滚', 2200
  );
  assert.throws(() => repositories.replyMatches.confirm({
    token: 'TOKEN-ROLLBACK', ericJid: '601@c.us', issueId: issue.id,
    eventUid: 'event-collision', replyUid: 'reply-must-rollback', now: 2300,
  }), /UNIQUE constraint failed/);
  assert.equal(repositories.replyMatches.findByToken('TOKEN-ROLLBACK').status, 'PENDING');
  const unchanged = repositories.issues.findByPublicId(issue.public_id);
  assert.equal(unchanged.status, 'WAITING_TEVAU');
  assert.equal(unchanged.first_replied_at, null);
  assert.equal(repositories.issues.listReplies(issue.id).length, 0);
  assert.equal(repositories.issues.listEvents(issue.id).length, 1);
  assert.equal(repositories.issues.search('atomicrollbackkeyword').length, 0);
  assert.equal(db.prepare(
    "SELECT count(*) AS count FROM issue_replies WHERE reply_uid='reply-must-rollback'"
  ).get().count, 0);
});

test('FTS synchronizes title/description/current confirmed replies and Chinese substring fallback', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  const issue = seedIssue(repositories, chat.id, 'fts', 2000, {
    title: 'Gateway timeout 网关异常',
    description: 'Settlement callback 商户结算回调延迟',
  });
  assert.equal(repositories.issues.search('Gateway').length, 1);
  assert.equal(repositories.issues.search('settlement callback').length, 1);
  assert.equal(repositories.issues.search('网关').length, 1); // two-code-point LIKE fallback
  assert.equal(repositories.issues.search('结算回').length, 1); // trigram path

  const source = seedMessage(repositories, chat.id, 'fts-reply', 2100);
  createReplySession(
    repositories, chat.id, source, issue, 'FTS', 'configuration repaired unicornreply 中文回复已修复', 2200
  );
  assert.equal(repositories.issues.search('unicornreply').length, 0);
  repositories.replyMatches.confirm({
    token: 'TOKEN-FTS', ericJid: '601@c.us', issueId: issue.id,
    eventUid: 'event-fts-confirm', replyUid: 'reply-fts-confirm', now: 2300,
  });
  assert.equal(repositories.issues.search('unicornreply').length, 1);
  assert.equal(repositories.issues.search('回复').length, 1);
  repositories.issues.update(issue.id, { title: 'Authentication repaired 身份修复' }, 2400);
  assert.equal(repositories.issues.search('Gateway').length, 0);
  assert.equal(repositories.issues.search('身份').length, 1);
  assert.equal(repositories.issues.search('unicornreply').length, 1);
  repositories.issues.softDelete(issue.id, 2500);
  assert.equal(repositories.issues.search('unicornreply').length, 0);
  repositories.issues.restore(issue.id, 2600);
  assert.equal(repositories.issues.search('unicornreply').length, 1);
});

test('admin move-reply changes durable current link and FTS without rewriting confirmation audit', (t) => {
  const { db, repositories } = fixture(t);
  const chat = seedChat(repositories);
  const original = seedIssue(repositories, chat.id, 'move-from', 2000);
  const target = seedIssue(repositories, chat.id, 'move-to', 2010);
  const source = seedMessage(repositories, chat.id, 'move-reply', 2100);
  createReplySession(repositories, chat.id, source, original, 'MOVE', 'movablekeyword 已经修复', 2200);
  const confirmed = repositories.replyMatches.confirm({
    token: 'TOKEN-MOVE', ericJid: '601@c.us', issueId: original.id,
    eventUid: 'event-before-move', replyUid: 'reply-to-move', now: 2300,
  });
  const immutableAuditBefore = db.prepare(
    'SELECT * FROM issue_events WHERE id = ?'
  ).get(confirmed.event.id);

  const moved = repositories.issues.moveReply({
    replyId: confirmed.reply.id, toIssueId: target.id,
    actorJid: 'admin@c.us', eventUid: 'event-move', reason: 'wrong match', now: 2400,
  });
  assert.equal(moved.reply.original_issue_id, original.id);
  assert.equal(moved.reply.current_issue_id, target.id);
  assert.deepEqual(db.prepare(
    'SELECT * FROM issue_events WHERE id = ?'
  ).get(confirmed.event.id), immutableAuditBefore);
  assert.equal(repositories.issues.listReplies(original.id).length, 0);
  assert.equal(repositories.issues.listReplies(target.id).length, 1);
  assert.equal(repositories.issues.search('movablekeyword', { chatId: chat.id })[0].id, target.id);
  assert.equal(repositories.issues.findByPublicId(original.public_id).status, 'WAITING_TEVAU');
  assert.equal(repositories.issues.findByPublicId(target.public_id).status, 'REPLIED');
  assert.equal(repositories.issues.listEvents(target.id).at(-1).event_type, 'REPLY_MOVED');

  const otherChat = seedChat(repositories, 'two', 2500);
  const crossChatTarget = seedIssue(repositories, otherChat.id, 'move-cross-chat', 2510);
  assert.throws(() => repositories.issues.moveReply({
    replyId: confirmed.reply.id, toIssueId: crossChatTarget.id,
    actorJid: 'admin@c.us', eventUid: 'event-cross-move', now: 2520,
  }), /different chat/);
  assert.equal(repositories.replyMatches.findReply(confirmed.reply.id).current_issue_id, target.id);
});

test('attachments derive chat/source identity, reject cross-chat links, and number attempts atomically', (t) => {
  const { db, repositories } = fixture(t);
  const chatOne = seedChat(repositories, 'one');
  const chatTwo = seedChat(repositories, 'two', 1001);
  const message = seedMessage(repositories, chatOne.id, 'attachment', 2000);
  const issue = seedIssue(repositories, chatOne.id, 'attachment', 2010);
  const otherIssue = seedIssue(repositories, chatTwo.id, 'attachment-other', 2020);
  const created = repositories.attachments.create({
    attachmentUid: 'attachment-one', idempotencyKey: 'wa-file-one',
    messageId: message.id, displayName: 'proof.md', detectedMime: 'text/markdown',
    sizeBytes: 12, now: 2100,
  });
  assert.equal(created.record.chat_id, chatOne.id);
  assert.equal(created.record.source_whatsapp_message_id, message.whatsapp_message_id);
  assert.throws(() => repositories.attachments.linkToIssue(
    created.record.id, otherIssue.id, 2200
  ), /different chat/);
  repositories.attachments.linkToIssue(created.record.id, issue.id, 2201);
  assert.throws(() => db.prepare(
    'UPDATE attachments SET source_whatsapp_message_id = ? WHERE id = ?'
  ).run('changed', created.record.id), /immutable/);

  // Exercise the legal lifecycle rather than bypassing strict extraction
  // states: DOWNLOAD archives bytes, then EXTRACT parses those bytes.
  const download = repositories.attachments.startAttempt({
    attemptUid: 'attempt-download', idempotencyKey: 'download-one',
    attachmentId: created.record.id, operation: 'DOWNLOAD', now: 2300,
  });
  assert.equal(download.record.attempt_number, 1);
  repositories.attachments.finalizeProcessingSuccess({
    attemptId: download.record.id,
    attachmentId: created.record.id,
    sha256: 'a'.repeat(64),
    storageKey: 'issues/one/proof.md',
    sizeBytes: 12,
    detectedMime: 'text/markdown',
    detectedExtension: 'md',
    displayName: 'proof.md',
    retentionClass: 'ISSUE',
    extractionEligible: true,
    now: 2350,
  });
  const unparsed = repositories.attachments.findById(created.record.id);
  assert.equal(unparsed.processing_status, 'UNPARSED');
  assert.equal(unparsed.parse_status, 'PENDING');

  assert.throws(() => repositories.transaction(() => {
    repositories.attachments.startAttempt({
      attemptUid: 'attempt-rollback', idempotencyKey: 'extract-rollback',
      attachmentId: created.record.id, operation: 'EXTRACT', now: 2390,
    });
    throw new Error('rollback attempt');
  }), /rollback attempt/);

  const attempt = repositories.attachments.startAttempt({
    attemptUid: 'attempt-one', idempotencyKey: 'extract-one',
    attachmentId: created.record.id, operation: 'EXTRACT', now: 2400,
  });
  assert.equal(attempt.record.attempt_number, 2);
  assert.equal(repositories.attachments.startAttempt({
    idempotencyKey: 'extract-one', attachmentId: created.record.id,
    operation: 'EXTRACT', now: 2401,
  }).record.attempt_number, 2);
  repositories.attachments.completeAttempt({
    attemptId: attempt.record.id, status: 'SUCCEEDED', attachmentStatus: 'READY',
    parseStatus: 'PARSED', extractedText: 'parsed markdown', now: 2500,
  });
  const parsed = repositories.attachments.findById(created.record.id);
  assert.equal(parsed.processing_status, 'READY');
  assert.equal(parsed.parse_status, 'PARSED');
  assert.throws(() => repositories.attachments.completeAttempt({
    attemptId: attempt.record.id, status: 'FAILED', now: 2501,
  }), /not active/);
  assert.deepEqual(
    repositories.attachments.listAttempts(created.record.id)
      .map((row) => [row.operation, row.attempt_number]),
    [['DOWNLOAD', 1], ['EXTRACT', 2]]
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('all chat-owned references reject cross-chat sources, events, attachments, sessions, candidates, and selection', (t) => {
  const { db, repositories } = fixture(t);
  const chatOne = seedChat(repositories, 'one');
  const chatTwo = seedChat(repositories, 'two', 1001);
  const messageOne = seedMessage(repositories, chatOne.id, 'chat-one', 2000);
  const messageTwo = seedMessage(repositories, chatTwo.id, 'chat-two', 2001);
  const issueOne = seedIssue(repositories, chatOne.id, 'chat-one', 2100);
  const issueTwo = seedIssue(repositories, chatTwo.id, 'chat-two', 2101);

  assert.throws(() => seedIssue(repositories, chatOne.id, 'cross-source', 2200, {
    sourceMessageId: messageTwo.id,
  }), /different chat/);
  assert.throws(() => repositories.issues.appendEvent({
    eventUid: 'cross-event', issueId: issueOne.id, eventType: 'UPDATED',
    actorJid: 'x@c.us', sourceMessageId: messageTwo.id, occurredAt: 2200,
  }), /different chat/);
  assert.throws(() => repositories.attachments.create({
    attachmentUid: 'cross-attachment', idempotencyKey: 'cross-attachment',
    messageId: messageOne.id, issueId: issueTwo.id,
    displayName: 'cross.pdf', sizeBytes: 1, now: 2200,
  }), /different chats/);
  assert.throws(() => repositories.replyMatches.create({
    sessionUid: 'cross-session', token: 'CROSS-SESSION', chatId: chatOne.id,
    sourceMessageId: messageTwo.id, sourceWhatsappMessageId: messageTwo.whatsapp_message_id,
    ericJid: '601@c.us', replyText: 'cross',
    candidates: [{ issueId: issueOne.id, confidence: 1, reason: 'x' }],
    createdAt: 2200, expiresAt: 2300,
  }), /different chat/);
  assert.throws(() => repositories.replyMatches.create({
    sessionUid: 'cross-candidate', token: 'CROSS-CANDIDATE', chatId: chatOne.id,
    sourceMessageId: messageOne.id, sourceWhatsappMessageId: messageOne.whatsapp_message_id,
    ericJid: '601@c.us', replyText: 'cross',
    candidates: [{ issueId: issueTwo.id, confidence: 1, reason: 'x' }],
    createdAt: 2200, expiresAt: 2300,
  }), /different chat/);

  const session = createReplySession(
    repositories, chatOne.id, messageOne, issueOne, 'SAME-CHAT', 'valid', 2200
  ).record;
  assert.throws(() => db.prepare(`
    UPDATE reply_match_sessions
    SET status='CONFIRMED', selected_issue_id=?, selected_issue_chat_id=?, consumed_at=2250
    WHERE id=?
  `).run(issueTwo.id, chatOne.id, session.id), /FOREIGN KEY constraint failed/);

  assert.throws(() => db.prepare(`
    INSERT INTO reply_match_candidates
      (session_id, issue_id, chat_id, position, confidence, reason)
    VALUES (?, ?, ?, 2, 0.5, 'cross raw')
  `).run(session.id, issueTwo.id, chatOne.id), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.prepare(`
    INSERT INTO issue_events (
      event_uid, issue_id, chat_id, event_type, actor_jid,
      source_message_id, source_message_chat_id, source_whatsapp_message_id,
      occurred_at, created_at
    ) VALUES ('cross-raw-event', ?, ?, 'UPDATED', 'x@c.us', ?, ?, ?, 2200, 2200)
  `).run(
    issueOne.id, chatOne.id, messageTwo.id, chatTwo.id, messageTwo.whatsapp_message_id
  ), /CHECK constraint failed|FOREIGN KEY constraint failed/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('reply session tokens/sources/candidates are unique and duplicate source delivery is idempotent', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  const messageOne = seedMessage(repositories, chat.id, 'unique-one', 2000);
  const messageTwo = seedMessage(repositories, chat.id, 'unique-two', 2001);
  const issueOne = seedIssue(repositories, chat.id, 'unique-one', 2100);
  const issueTwo = seedIssue(repositories, chat.id, 'unique-two', 2101);
  const sourceSnapshot = {
    sourceSenderJid: '60999999999@c.us',
    sourceSentAt: 2190,
    sourceMedia: { type: 'document', fileName: 'reply.pdf' },
  };
  const first = repositories.replyMatches.create({
    sessionUid: 'session-UNIQUE', token: 'TOKEN-UNIQUE', chatId: chat.id,
    sourceMessageId: messageOne.id, sourceWhatsappMessageId: messageOne.whatsapp_message_id,
    ericJid: '601@c.us', replyText: 'same reply', ...sourceSnapshot,
    candidates: [{ issueId: issueOne.id, confidence: 0.9, reason: 'best match' }],
    createdAt: 2200, expiresAt: 3200,
  });
  const replayInput = {
    sessionUid: 'ignored-session', token: 'OTHER-TOKEN', chatId: chat.id,
    sourceMessageId: messageOne.id, sourceWhatsappMessageId: messageOne.whatsapp_message_id,
    ericJid: '601@c.us', replyText: 'same reply', ...sourceSnapshot,
    candidates: [{ issueId: issueOne.id, confidence: 0.1, reason: 'retry' }],
    createdAt: 2201, expiresAt: 3201,
  };
  const duplicate = repositories.replyMatches.create(replayInput);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.id, first.record.id);
  assert.throws(() => repositories.replyMatches.create({
    ...replayInput, sourceMessageId: null,
  }), /idempotency conflict on source_message_id/u);
  for (const mismatch of [
    { sourceSenderJid: '60888888888@c.us' },
    { sourceSentAt: 2191 },
    { sourceMedia: { type: 'document', fileName: 'different.pdf' } },
    { replyText: 'changed source reply' },
  ]) {
    assert.throws(() => repositories.replyMatches.create({
      ...replayInput, ...mismatch,
    }), /reply match session idempotency conflict/u);
  }
  assert.throws(() => repositories.replyMatches.create({
    sessionUid: 'token-collision', token: 'TOKEN-UNIQUE', chatId: chat.id,
    sourceMessageId: messageTwo.id, sourceWhatsappMessageId: messageTwo.whatsapp_message_id,
    ericJid: '601@c.us', replyText: 'different source',
    candidates: [{ issueId: issueTwo.id, confidence: 1, reason: 'only' }],
    createdAt: 2202, expiresAt: 3202,
  }), /UNIQUE constraint failed/);
  assert.throws(() => repositories.replyMatches.create({
    sessionUid: 'duplicate-candidates', token: 'DUP-CANDIDATE', chatId: chat.id,
    sourceWhatsappMessageId: 'external-duplicate', ericJid: '601@c.us', replyText: 'x',
    candidates: [
      { issueId: issueOne.id, confidence: 1, reason: 'one' },
      { issueId: issueOne.id, confidence: 0.5, reason: 'same' },
    ],
    createdAt: 2203, expiresAt: 3203,
  }), /must be unique/);
});

test('reply sessions reject wrong actor/candidate, expire at boundary, and preserve pending state on failures', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  const message = seedMessage(repositories, chat.id, 'reply', 2000);
  const issueOne = seedIssue(repositories, chat.id, 'candidate-one', 2100);
  const issueTwo = seedIssue(repositories, chat.id, 'candidate-two', 2110);
  repositories.replyMatches.create({
    sessionUid: 'session-one', token: 'TOKEN-ONE', chatId: chat.id,
    sourceMessageId: message.id, sourceWhatsappMessageId: message.whatsapp_message_id,
    ericJid: '601@c.us', replyText: 'Tevau fixed it',
    candidates: [{ issueId: issueOne.id, confidence: 0.8, reason: 'best' }],
    createdAt: 2200, expiresAt: 2300,
  });
  assert.equal(repositories.replyMatches.confirm({
    token: 'TOKEN-ONE', ericJid: 'wrong@c.us', issueId: issueOne.id, now: 2250,
  }), null);
  assert.equal(repositories.replyMatches.confirm({
    token: 'TOKEN-ONE', ericJid: '601@c.us', issueId: issueTwo.id, now: 2250,
  }), null);
  assert.equal(repositories.replyMatches.findByToken('TOKEN-ONE').status, 'PENDING');
  assert.equal(repositories.replyMatches.confirm({
    token: 'TOKEN-ONE', ericJid: '601@c.us', issueId: issueOne.id, now: 2301,
  }), null);
  assert.equal(repositories.replyMatches.findByToken('TOKEN-ONE').status, 'EXPIRED');
});

test('summary manifests are sealed, allow identical content at different indexes, and finalize idempotently', (t) => {
  const { db, repositories } = fixture(t);
  const chat = seedChat(repositories);
  const run = repositories.summaries.claim({
    runUid: 'run-one', chatId: chat.id, reportType: 'AUTO_10',
    windowStart: 1000, windowEnd: 2000, scheduledFor: 2000,
    leaseMs: 1000, now: 2001,
  }).record;
  const first = repositories.summaries.addPart({
    partUid: 'part-one', runId: run.id, partIndex: 0, content: 'identical', now: 2100,
  }).record;
  const second = repositories.summaries.addPart({
    partUid: 'part-two', runId: run.id, partIndex: 1, content: 'identical', now: 2100,
  }).record;
  assert.equal(first.content_hash, second.content_hash);
  assert.throws(() => repositories.summaries.complete(run.id, 2200), /unsealed/);
  const sealed = repositories.summaries.seal(run.id, 2200);
  assert.equal(sealed.expected_part_count, 2);
  assert.equal(repositories.summaries.seal(run.id, 2201).manifest_hash, sealed.manifest_hash);
  assert.throws(() => repositories.summaries.addPart({
    runId: run.id, partIndex: 2, content: 'late', now: 2202,
  }), /manifest is sealed/);

  assert.ok(repositories.summaries.markPartSending(first.id, 2300, { leaseMs: 100 }));
  const ack = repositories.summaries.markPartSent({
    partId: first.id, whatsappMessageId: 'sent-wa-1', now: 2310,
  });
  assert.equal(repositories.summaries.markPartSent({
    partId: first.id, whatsappMessageId: 'sent-wa-1', now: 2311,
  }).id, ack.id);
  assert.throws(() => repositories.summaries.markPartSent({
    partId: first.id, whatsappMessageId: 'different-ack', now: 2312,
  }), /idempotency conflict/);
  repositories.summaries.markPartSent({
    partId: second.id, whatsappMessageId: 'sent-wa-2', now: 2320,
  });
  const completed = repositories.summaries.complete(run.id, 2400);
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(repositories.summaries.complete(run.id, 2401).completed_at, 2400);
  assert.throws(() => repositories.summaries.addPart({
    runId: run.id, partIndex: 2, content: 'post-success', now: 2500,
  }), /manifest is sealed/);
  assert.throws(() => db.prepare(`
    INSERT INTO summary_run_parts (
      part_uid, run_id, part_index, content, content_hash, status, created_at, updated_at
    ) VALUES ('raw-late', ?, 2, 'late', ?, 'PENDING', 2500, 2500)
  `).run(run.id, 'a'.repeat(64)), /manifest is sealed|not active/);
});

test('summary ledger rejects manifest gaps and acknowledgements before sealing', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  const run = repositories.summaries.claim({
    runUid: 'run-gap', chatId: chat.id, reportType: 'MANUAL',
    windowStart: 1000, windowEnd: 2000, scheduledFor: 2000, now: 2000,
  }).record;
  const part = repositories.summaries.addPart({
    partUid: 'part-gap', runId: run.id, partIndex: 1, content: 'gap', now: 2001,
  }).record;
  assert.equal(repositories.summaries.markPartSent({
    partId: part.id, whatsappMessageId: 'must-not-ack', now: 2002,
  }), null);
  assert.throws(() => repositories.summaries.seal(run.id, 2003), /contiguous/);
  assert.throws(() => repositories.summaries.addPart({
    runId: run.id, partIndex: 1, content: 'changed', now: 2004,
  }), /idempotency conflict/);
});

test('summary RUNNING/FAILED and SENDING/FAILED work are reclaimable only after lease rules', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  const input = {
    runUid: 'run-lease', chatId: chat.id, reportType: 'RECOVERY',
    windowStart: 10, windowEnd: 20, scheduledFor: 20, leaseMs: 10,
  };
  const initial = repositories.summaries.claim({ ...input, now: 100 });
  assert.equal(initial.record.attempt_count, 1);
  const busy = repositories.summaries.claim({ ...input, runUid: 'ignored', now: 105 });
  assert.equal(busy.reclaimed, false);
  assert.equal(busy.record.attempt_count, 1);
  const stale = repositories.summaries.claim({ ...input, runUid: 'ignored', now: 111 });
  assert.equal(stale.reclaimed, true);
  assert.equal(stale.record.attempt_count, 2);

  const part = repositories.summaries.addPart({
    partUid: 'lease-part', runId: stale.record.id, partIndex: 0,
    content: 'lease work', now: 112,
  }).record;
  repositories.summaries.seal(stale.record.id, 113);
  assert.equal(repositories.summaries.markPartSending(
    part.id, 114, { leaseMs: 10 }
  ).attempt_count, 1);
  assert.equal(repositories.summaries.markPartSending(
    part.id, 120, { leaseMs: 10 }
  ), null);
  assert.equal(repositories.summaries.markPartSending(
    part.id, 125, { leaseMs: 10 }
  ).attempt_count, 2);
  repositories.summaries.markPartFailed({ partId: part.id, error: 'send failed', now: 126 });
  assert.equal(repositories.summaries.markPartSending(
    part.id, 127, { leaseMs: 10 }
  ).attempt_count, 3);

  repositories.summaries.fail(stale.record.id, 'run failed', 128);
  const failed = repositories.summaries.claim({ ...input, runUid: 'ignored', now: 129 });
  assert.equal(failed.reclaimed, true);
  assert.equal(failed.record.status, 'RUNNING');
  assert.equal(failed.record.attempt_count, 3);
});

test('summary message IDs are globally unique and a failed duplicate acknowledgement is rollback-safe', (t) => {
  const { repositories } = fixture(t);
  const chat = seedChat(repositories);
  function readyRun(uid, type, scheduled, messageId) {
    const run = repositories.summaries.claim({
      runUid: uid, chatId: chat.id, reportType: type,
      windowStart: scheduled - 100, windowEnd: scheduled,
      scheduledFor: scheduled, now: scheduled,
    }).record;
    const part = repositories.summaries.addPart({
      partUid: `${uid}-part`, runId: run.id, partIndex: 0, content: uid, now: scheduled,
    }).record;
    repositories.summaries.seal(run.id, scheduled);
    if (messageId) repositories.summaries.markPartSent({
      partId: part.id, whatsappMessageId: messageId, now: scheduled,
    });
    return { run, part };
  }
  readyRun('run-unique-one', 'AUTO_14', 3000, 'global-wa-id');
  const other = readyRun('run-unique-two', 'AUTO_20', 4000);
  assert.throws(() => repositories.summaries.markPartSent({
    partId: other.part.id, whatsappMessageId: 'global-wa-id', now: 4001,
  }), /UNIQUE constraint failed/);
  assert.equal(repositories.summaries.listParts(other.run.id)[0].status, 'PENDING');
});

test('cross-repository transaction rolls back all writes and leaves integrity clean', (t) => {
  const { db, repositories } = fixture(t);
  assert.throws(() => repositories.transaction((tx) => {
    const chat = tx.chats.create({ jid: 'rollback@g.us', timezone: 'UTC', now: 1 }).record;
    tx.permissions.set({
      chatId: chat.id, canonicalJid: '601@c.us', role: 'ADMIN', now: 2,
    });
    tx.messages.create({
      whatsappMessageId: 'rollback-message', chatId: chat.id,
      senderJid: '601@c.us', sentAt: 3, receivedAt: 3,
    });
    throw new Error('all-or-nothing');
  }), /all-or-nothing/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM chats WHERE jid='rollback@g.us'").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM permissions").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM permission_roles").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
