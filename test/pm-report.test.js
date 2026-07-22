'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { issueSnapshot } = require('../services/issue-service');
const { PmReportService } = require('../summaries/pm-report');
const { formatPmReport } = require('../summaries/pm-report-formatter');
const {
  createWindowCalculator,
  localBoundaryToUtcMs,
  localDayWindow,
  scheduledReportWindow,
} = require('../summaries/window');

const KL = 'Asia/Kuala_Lumpur';

function utc(iso) {
  return DateTime.fromISO(iso, { zone: 'UTC' }).toMillis();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-pm-report-test-'));
  const db = getDatabase({ filename: path.join(root, 'report.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({
    chatUid: 'report-chat',
    jid: '120300000000000000@g.us',
    timezone: KL,
    now: 2,
  }).record;
  let sequence = 0;
  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    chat,
    db,
    repositories,
    uid(prefix) {
      sequence += 1;
      return `${prefix}-${sequence}`;
    },
  };
}

function createIssue(context, createdAt, title, extra = {}) {
  const suffix = context.uid('issue');
  return context.repositories.issues.create({
    issueUid: suffix,
    eventUid: context.uid('created'),
    idempotencyKey: context.uid('command'),
    chatId: context.chat.id,
    title,
    description: `${title} description`,
    createdByJid: extra.createdByJid || '60111111111@c.us',
    sourceMessageId: extra.sourceMessageId,
    sourceWhatsappMessageId: extra.sourceWhatsappMessageId,
    sourceSnapshot: extra.sourceSnapshot,
    now: createdAt,
  }).record;
}

function mutate(context, issue, eventType, occurredAt, patch = {}) {
  const repository = context.repositories.issues;
  const before = repository.findById(issue.id, { includeDeleted: true });
  let after;
  if (eventType === 'DELETED') {
    after = repository.softDelete(issue.id, occurredAt);
  } else if (eventType === 'RESTORED' && before.deleted_at !== null) {
    after = repository.restore(issue.id, occurredAt);
  } else {
    after = repository.update(issue.id, patch, occurredAt);
  }
  repository.appendEvent({
    eventUid: context.uid(eventType.toLowerCase()),
    issueId: issue.id,
    eventType,
    actorJid: '60333333333@c.us',
    before: issueSnapshot(before),
    after: issueSnapshot(after),
    reason: `${eventType} test`,
    occurredAt,
  });
  return after;
}

function confirmReply(context, issue, occurredAt, text) {
  const repository = context.repositories.issues;
  const before = repository.findById(issue.id, { includeDeleted: true });
  const after = repository.update(issue.id, {
    status: 'REPLIED',
    firstRepliedAt: before.first_replied_at ?? occurredAt,
  }, occurredAt);
  repository.insertEvent({
    eventUid: context.uid('reply'),
    issueId: issue.id,
    eventType: 'REPLY_CONFIRMED',
    actorJid: '60222222222@c.us',
    replyText: text,
    before: { status: before.status, firstRepliedAt: before.first_replied_at },
    after: { status: after.status, firstRepliedAt: after.first_replied_at },
    reason: 'Confirmed Tevau reply',
    occurredAt,
  });
  return after;
}

function createMessage(context, sentAt, suffix, { command = false } = {}) {
  return context.repositories.messages.create({
    messageUid: `message-${suffix}`,
    whatsappMessageId: `wa-${suffix}`,
    chatId: context.chat.id,
    senderJid: '60111111111@c.us',
    body: command ? '!pm list open' : `message ${suffix}`,
    sentAt,
    receivedAt: sentAt,
    isCommand: command,
  }).record;
}

test('all three Kuala Lumpur slots use exact half-open UTC boundaries', () => {
  const ten = scheduledReportWindow({ slot: '10:00', localDate: '2026-07-22' });
  assert.deepEqual({ start: ten.startUtcMs, end: ten.endUtcMs, scheduled: ten.scheduledForUtcMs }, {
    start: utc('2026-07-21T12:00:00Z'),
    end: utc('2026-07-22T02:00:00Z'),
    scheduled: utc('2026-07-22T02:00:00Z'),
  });
  assert.deepEqual({ start: ten.previousDay.startUtcMs, end: ten.previousDay.endUtcMs }, {
    start: utc('2026-07-20T16:00:00Z'),
    end: utc('2026-07-21T16:00:00Z'),
  });

  const fourteen = scheduledReportWindow({ slot: 14, localDate: '2026-07-22' });
  assert.deepEqual({ start: fourteen.startUtcMs, end: fourteen.endUtcMs }, {
    start: utc('2026-07-22T02:00:00Z'), end: utc('2026-07-22T06:00:00Z'),
  });
  assert.equal(fourteen.previousDay, null);

  const twenty = scheduledReportWindow({ slot: 'AUTO_20', localDate: '2026-07-22' });
  assert.deepEqual({ start: twenty.startUtcMs, end: twenty.endUtcMs }, {
    start: utc('2026-07-22T06:00:00Z'), end: utc('2026-07-22T12:00:00Z'),
  });
});

test('window helpers cross month/year boundaries, derive dates from an injected clock, and reject invalid input', () => {
  const month = scheduledReportWindow({ slot: '10:00', localDate: '2026-03-01' });
  assert.equal(month.startUtcMs, utc('2026-02-28T12:00:00Z'));
  const year = scheduledReportWindow({ slot: '10:00', localDate: '2026-01-01' });
  assert.equal(year.startUtcMs, utc('2025-12-31T12:00:00Z'));

  let calls = 0;
  const calculator = createWindowCalculator({
    timezone: KL,
    clock: () => { calls += 1; return utc('2026-12-31T16:30:00Z'); },
  });
  const derived = calculator.scheduled('10:00');
  assert.equal(derived.endUtcMs, utc('2027-01-01T02:00:00Z'));
  assert.equal(calls, 1);

  for (const slot of ['', '09:00', 9, null]) {
    assert.throws(() => scheduledReportWindow({ slot, localDate: '2026-07-22' }), /slot/i);
  }
  for (const date of ['2026-02-29', '2026-2-01', 'not-a-date', '']) {
    assert.throws(() => scheduledReportWindow({ slot: '10:00', localDate: date }), /localDate/i);
  }
  assert.throws(() => scheduledReportWindow({
    slot: '10:00', clock: () => NaN,
  }), /clock/);
  assert.throws(() => scheduledReportWindow({
    slot: '10:00', localDate: '2026-07-22', timezone: 'Mars/Olympus',
  }), /timezone/);
  assert.throws(() => scheduledReportWindow({
    slot: '10:00', localDate: '2026-07-22', timezone: 'system',
  }), /System-local timezone/);
});

test('pure Luxon local helpers are system-timezone independent and DST-correct', () => {
  const spring = localDayWindow('2026-03-08', { timezone: 'America/New_York' });
  const fall = localDayWindow('2026-11-01', { timezone: 'America/New_York' });
  assert.equal(spring.endUtcMs - spring.startUtcMs, 23 * 60 * 60 * 1000);
  assert.equal(fall.endUtcMs - fall.startUtcMs, 25 * 60 * 60 * 1000);
  assert.throws(() => localBoundaryToUtcMs({
    localDate: '2026-03-08', hour: 2, minute: 30, timezone: 'America/New_York',
  }), /Invalid local boundary/);
  assert.equal(
    localBoundaryToUtcMs({ localDate: '2026-03-08', hour: 10, timezone: 'America/New_York' }),
    utc('2026-03-08T14:00:00Z')
  );
});

test('report events and messages honor exact boundaries and never leak later issue state', (t) => {
  const context = fixture(t);
  const window = scheduledReportWindow({ slot: '14:00', localDate: '2026-07-22' });
  const issue = createIssue(context, window.startUtcMs - 1000, 'Historical title');
  confirmReply(context, issue, window.startUtcMs, 'first boundary reply');
  mutate(context, issue, 'UPDATED', window.startUtcMs + 1000, { title: 'Window title' });
  mutate(context, issue, 'DELETED', window.startUtcMs + 2000);
  mutate(context, issue, 'RESTORED', window.startUtcMs + 3000);
  mutate(context, issue, 'UPDATED', window.endUtcMs + 1000, { title: 'Future current title' });
  const archived = createIssue(context, window.startUtcMs - 2000, 'Archived historical title');
  confirmReply(context, archived, window.startUtcMs - 1500, 'reply before window');
  mutate(context, archived, 'RESOLVED', window.startUtcMs + 4000, {
    status: 'RESOLVED', resolvedAt: window.startUtcMs + 4000,
  });
  mutate(context, archived, 'ARCHIVED', window.startUtcMs + 5000, {
    status: 'ARCHIVED', archivedAt: window.startUtcMs + 5000,
  });
  createIssue(context, window.endUtcMs, 'End boundary excluded');

  createMessage(context, window.startUtcMs, 'at-start');
  createMessage(context, window.startUtcMs + 1, 'command-inside', { command: true });
  createMessage(context, window.endUtcMs, 'at-end');

  const report = new PmReportService({
    repositories: context.repositories,
    timezone: KL,
    clock: () => window.endUtcMs + 2000,
  }).build({ chatId: context.chat.id, window });

  assert.equal(report.messageCount, 1);
  assert.equal(report.changes.replies.length, 1);
  assert.equal(report.changes.replies[0].occurredAtUtcMs, window.startUtcMs);
  assert.equal(report.changes.replies[0].title, 'Historical title');
  assert.equal(report.changes.updated.length, 1);
  assert.equal(report.changes.updated[0].title, 'Window title');
  assert.equal(report.changes.deleted.length, 1);
  assert.equal(report.changes.restored.length, 1);
  assert.equal(report.changes.resolved.length, 1);
  assert.equal(report.changes.archived.length, 1);
  assert.equal(report.changes.created.length, 0, 'the exact end boundary is excluded');
  assert.equal(JSON.stringify(report.changes).includes('Future current title'), false);
});

test('10:00 stats count reply issues and events separately and reconstruct historical day-end unresolved state', (t) => {
  const context = fixture(t);
  const window = scheduledReportWindow({ slot: '10:00', localDate: '2026-07-22' });
  const dayStart = window.previousDay.startUtcMs;
  const dayEnd = window.previousDay.endUtcMs;

  const staysOpenHistorically = createIssue(context, dayStart - 5000, 'Open at day end');
  confirmReply(context, staysOpenHistorically, dayStart + 1000, 'reply one');
  confirmReply(context, staysOpenHistorically, dayStart + 2000, 'reply two');
  mutate(context, staysOpenHistorically, 'RESOLVED', dayEnd + 1000, {
    status: 'RESOLVED', resolvedAt: dayEnd + 1000,
  });

  const resolvedDuringDay = createIssue(context, dayStart + 3000, 'Resolved in day');
  confirmReply(context, resolvedDuringDay, dayStart + 4000, 'reply three');
  mutate(context, resolvedDuringDay, 'RESOLVED', dayStart + 5000, {
    status: 'RESOLVED', resolvedAt: dayStart + 5000,
  });

  const remainsDeleted = createIssue(context, dayStart - 4000, 'Deleted at day end');
  mutate(context, remainsDeleted, 'DELETED', dayStart + 6000);
  const restored = createIssue(context, dayStart - 3000, 'Restored at day end');
  mutate(context, restored, 'DELETED', dayStart + 7000);
  mutate(context, restored, 'RESTORED', dayStart + 8000);
  createIssue(context, dayEnd, 'Created exactly at next day');

  const report = new PmReportService({
    repositories: context.repositories,
    timezone: KL,
    clock: () => window.endUtcMs,
  }).build({ chatId: context.chat.id, window });
  assert.deepEqual(report.previousDayStats, {
    startUtcMs: dayStart,
    endUtcMs: dayEnd,
    createdIssueCount: 1,
    confirmedReplyIssueCount: 2,
    confirmedReplyEventCount: 3,
    resolvedIssueCount: 1,
    unresolvedAtEndIssueCount: 2,
  });
  assert.ok(report.changes.resolved.some((event) => (
    event.publicId === staysOpenHistorically.public_id
  )), 'resolution after yesterday end belongs to the rolling report but not yesterday end state');
});

test('deterministic queues include 6+ tickets with stable waiting ties, all REPLIED, parse gaps, and uncertainties', (t) => {
  const context = fixture(t);
  const window = scheduledReportWindow({ slot: '20:00', localDate: '2026-07-22' });
  const now = window.endUtcMs + 10_000;
  const source = createMessage(context, now - 30_000, 'uncertain-source');
  const command = createMessage(context, now - 29_000, 'uncertain-command', { command: true });
  const waiting = [];
  waiting.push(createIssue(context, now - 60_000, 'Oldest'));
  waiting.push(createIssue(context, now - 50_000, 'Tie first'));
  waiting.push(createIssue(context, now - 50_000, 'Tie second'));
  waiting.push(createIssue(context, now - 40_000, 'Fourth'));
  waiting.push(createIssue(context, now - 30_000, 'Fifth'));
  waiting.push(createIssue(context, now - 20_000, 'Sixth'));
  waiting.push(createIssue(context, now - 10_000, 'Uncertain seventh', {
    sourceMessageId: source.id,
    sourceWhatsappMessageId: source.whatsapp_message_id,
    sourceSnapshot: {
      commandMessageId: command.id,
      commandWhatsappMessageId: command.whatsapp_message_id,
      sourceMessageId: source.id,
      sourceWhatsappMessageId: source.whatsapp_message_id,
      sourceBody: source.body,
      sourceSenderJid: source.sender_jid,
      sourceSentAt: source.sent_at,
      extractionStatus: 'FALLBACK',
      aiAttempts: 0,
      aiErrorCode: 'AI_UNAVAILABLE',
      uncertainties: ['商户编号尚未确认'],
    },
  }));
  const repliedOne = createIssue(context, now - 45_000, 'Replied one');
  const repliedTwo = createIssue(context, now - 35_000, 'Replied two');
  confirmReply(context, repliedOne, now - 15_000, 'reply A');
  confirmReply(context, repliedTwo, now - 5_000, 'reply B');

  context.repositories.attachments.create({
    attachmentUid: context.uid('attachment'), idempotencyKey: context.uid('attachment-key'),
    issueId: waiting[0].id, displayName: 'pending.pdf', sizeBytes: 10,
    retentionClass: 'ISSUE', processingStatus: 'PENDING', now: now - 1000,
  });
  context.repositories.attachments.create({
    attachmentUid: context.uid('attachment'), idempotencyKey: context.uid('attachment-key'),
    issueId: waiting[0].id, displayName: 'failed.pdf', sizeBytes: 10,
    retentionClass: 'ISSUE', processingStatus: 'FAILED', parseError: 'failed', now: now - 900,
  });

  const report = new PmReportService({
    repositories: context.repositories,
    timezone: KL,
    clock: () => now,
  }).build({ chatId: context.chat.id, window });

  assert.equal(report.aiUsed, false);
  assert.equal(report.queues.waitingTevau.length, 7);
  assert.equal(report.queues.repliedUnresolved.length, 2);
  assert.deepEqual(report.queues.waitingTevau.map((issue) => issue.title), [
    'Oldest', 'Tie first', 'Tie second', 'Fourth', 'Fifth', 'Sixth', 'Uncertain seventh',
  ]);
  assert.equal(report.queues.waitingTevau[0].waitingDurationMs, 60_000);
  assert.deepEqual(report.queues.waitingTevau[0].attachments, {
    count: 2, parsePendingCount: 1, parseFailedCount: 1, savedUnparsedCount: 0,
  });
  assert.deepEqual(report.queues.repliedUnresolved.map((issue) => issue.title), [
    'Replied one', 'Replied two',
  ]);
  assert.equal(report.uncertainties[0].text, '商户编号尚未确认');
  assert.ok(report.dataGaps.some((gap) => gap.kind === 'ISSUE_EXTRACTION_FALLBACK'));
  assert.ok(report.dataGaps.some((gap) => gap.kind === 'ATTACHMENT_PARSE_PENDING'));
  assert.ok(report.dataGaps.some((gap) => gap.kind === 'ATTACHMENT_PARSE_FAILED'));

  const rendered = formatPmReport(report, { aiUnavailable: true });
  for (const issue of [...report.queues.waitingTevau, ...report.queues.repliedUnresolved]) {
    assert.match(rendered, new RegExp(issue.publicId));
  }
  assert.match(rendered, /等待 Tevau 回复（7）/u);
  assert.match(rendered, /已回复、待解决（2）/u);
  assert.match(rendered, /AI 群聊摘要不可用/u);
  assert.match(rendered, /待解析 1｜解析失败 1/u);
});

test('empty windows and no AI dependency still render a truthful local PM model', (t) => {
  const context = fixture(t);
  const window = scheduledReportWindow({ slot: '14:00', localDate: '2026-12-31' });
  const report = new PmReportService({
    repositories: context.repositories,
    timezone: KL,
    clock: () => window.endUtcMs,
  }).build({ chatId: context.chat.id, window });
  assert.equal(report.messageCount, 0);
  assert.equal(report.changeEventCount, 0);
  assert.deepEqual(report.queues.waitingTevau, []);
  assert.deepEqual(report.queues.repliedUnresolved, []);
  assert.equal(report.aiUsed, false);
  assert.equal(Object.values(report.changes).every((events) => events.length === 0), true);

  const rendered = formatPmReport(report, { aiUnavailable: true });
  assert.match(rendered, /2026-12-31 10:00 → 2026-12-31 14:00/u);
  assert.match(rendered, /非命令消息：0｜工单变化：0/u);
  assert.match(rendered, /本窗口无工单变化/u);
  assert.match(rendered, /等待 Tevau 回复（0）/u);
  assert.match(rendered, /已回复、待解决（0）/u);
  assert.doesNotMatch(rendered, /Invalid Date|NaN|undefined/u);
});
