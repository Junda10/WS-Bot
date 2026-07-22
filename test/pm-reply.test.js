'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPmCommandHandlers } = require('../commands/pm-handler');
const { createCommandRouter } = require('../commands/router');
const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { IssueService } = require('../services/issue-service');
const { AuthorizationError, PermissionService } = require('../services/permission-service');
const { PmAiService } = require('../services/pm-ai-service');
const { PmReplyService } = require('../services/pm-reply-service');

const CHAT = '120300000000000077@g.us';
const OTHER_CHAT = '120300000000000078@g.us';
const MEMBER = '60111111111@c.us';
const ERIC = '60222222222@c.us';
const ERIC_ALIAS = '60222222222@lid';
const OTHER_ERIC = '60299999999@c.us';
const ADMIN = '60333333333@c.us';

class FakeAdapter {
  constructor(clock) {
    this.clock = clock;
    this.sends = [];
    this.failNext = null;
    this.number = 0;
  }

  async sendParts(chatJid, parts, options) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.number += 1;
    const receipt = { id: `bot-suggestion-${this.number}`, sentAt: this.clock() };
    this.sends.push({ chatJid, parts, options, receipt });
    return [receipt];
  }

  async sendArchivedAttachment() {
    throw new Error('not used');
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-pm-reply-'));
  const attachmentsDir = path.join(root, 'attachments');
  fs.mkdirSync(attachmentsDir);
  const db = getDatabase({ filename: path.join(root, 'db.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({
    chatUid: 'reply-chat', jid: CHAT, timezone: 'Asia/Kuala_Lumpur', now: 10,
  }).record;
  const otherChat = repositories.chats.create({
    chatUid: 'reply-other-chat', jid: OTHER_CHAT, timezone: 'Asia/Kuala_Lumpur', now: 10,
  }).record;
  for (const [jid, role] of [
    [MEMBER, 'MEMBER'], [ERIC, 'MEMBER'], [ERIC, 'ERIC'], [OTHER_ERIC, 'MEMBER'],
    [OTHER_ERIC, 'ERIC'], [ADMIN, 'ADMIN'],
  ]) repositories.permissions.set({ chatId: chat.id, canonicalJid: jid, role, now: 20 });
  const ericPermission = repositories.permissions.resolve(chat.id, ERIC);
  repositories.permissions.addAlias({
    aliasUid: 'reply-eric-alias', permissionId: ericPermission.id,
    aliasJid: ERIC_ALIAS, now: 21,
  });
  for (const role of ['MEMBER', 'ERIC']) {
    repositories.permissions.set({ chatId: otherChat.id, canonicalJid: ERIC, role, now: 20 });
  }

  let now = 1_000_000;
  let commandNumber = 0;
  const clock = () => now;
  const setTime = (value) => { now = value; };
  const permissions = new PermissionService({
    repositories, authorizedChatJid: CHAT, ericJid: ERIC,
  });
  const issueService = new IssueService({ repositories, permissionService: permissions, clock });
  const aiState = {
    calls: [],
    response(candidates) {
      return {
        ok: true,
        value: {
          selectedPublicId: candidates[0].publicId,
          confidence: 'high',
          reason: '权限与登录关键词完全对应',
          rankedCandidates: candidates.slice(0, 3).map((candidate, index) => ({
            publicId: candidate.publicId,
            confidence: index === 0 ? 'high' : 'low',
            reason: index === 0 ? '最相关' : '备选',
          })),
        },
        model: 'fake/reply-model', attempts: 1, error: null,
      };
    },
  };
  const aiClient = {
    async extractIssue() { throw new Error('not used'); },
    async summarizeConversation() { throw new Error('not used'); },
    async matchReply(evidence, candidates) {
      aiState.calls.push({ evidence, candidates });
      return aiState.response(candidates);
    },
  };
  const pmAi = new PmAiService({
    aiClient, issueRepository: repositories.issues, maxCandidates: 3, now: clock,
  });
  const adapter = new FakeAdapter(clock);
  const logs = [];

  function buildRuntime() {
    const replyService = new PmReplyService({
      repositories, permissionService: permissions, issueService, aiService: pmAi,
      ttlMs: 15 * 60 * 1000, clock,
    });
    const handlers = createPmCommandHandlers({
      issueService, permissionService: permissions, pmReplyService: replyService,
      adapter, attachmentsDir, clock,
      logger: { error: (...entries) => logs.push(entries) },
    });
    return {
      replyService,
      router: createCommandRouter({ permissionService: permissions, pmHandlers: handlers, clock }),
    };
  }
  let runtime = buildRuntime();

  function createIssue(index, extra = {}) {
    setTime(1_000_000 + index * 100);
    return issueService.create({
      chatJid: CHAT, actorJid: MEMBER,
      issueUid: `reply-issue-${index}`, eventUid: `reply-created-${index}`,
      idempotencyKey: `reply-command-${index}`,
      title: extra.title || `Merchant login permission 403 case ${index}`,
      description: extra.description || `Merchant M${index} cannot login due to permission 403`,
      reason: 'test issue',
    }).record;
  }

  async function route(body, options = {}) {
    commandNumber += 1;
    const id = options.id || `reply-command-message-${commandNumber}`;
    const quotedId = options.quotedId || null;
    const normalized = {
      id,
      chatJid: options.chatJid || CHAT,
      senderJid: options.senderJid || ERIC,
      isGroup: true,
      body,
      quoted: quotedId ? {
        id: quotedId,
        chatJid: options.quoteChatJid || CHAT,
        senderJid: options.quoteSenderJid || '60444444444@c.us',
        body: options.quoteBody ?? '权限配置已经修复，请商户重新登录。',
        sentAt: options.quoteSentAt ?? 900_000,
        media: options.quoteMedia ?? null,
      } : null,
    };
    const persisted = {
      id: options.persistedId || 10_000 + commandNumber,
      whatsapp_message_id: id,
      quoted_whatsapp_message_id: quotedId,
      quoted_body: options.quoteBody ?? (quotedId ? '权限配置已经修复，请商户重新登录。' : null),
      quoted_sender_jid: options.quoteSenderJid || (quotedId ? '60444444444@c.us' : null),
      quoted_sent_at: options.quoteSentAt ?? (quotedId ? 900_000 : null),
      quoted_media_json: options.quoteMedia ? JSON.stringify(options.quoteMedia) : null,
    };
    return runtime.router.route({ body, reply: async () => {} }, normalized, persisted);
  }

  function restartRuntime() {
    runtime = buildRuntime();
    return runtime;
  }

  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    adapter, aiState, chat, otherChat, createIssue, db, issueService, logs, permissions,
    repositories, restartRuntime, route, setTime,
    get now() { return now; },
    get runtime() { return runtime; },
  };
}

function handlerValue(routed) {
  return routed.value.value;
}

function lastOutput(context) {
  return context.adapter.sends.at(-1).parts.join('\n');
}

test('5+ unresolved shortlist, high-confidence AI, immutable absent-source snapshot, and quoted prompt confirmation stay pending until Eric confirms', async (t) => {
  const context = fixture(t);
  const issues = [];
  for (let index = 1; index <= 6; index += 1) issues.push(context.createIssue(index));
  context.repositories.issues.update(issues[5].id, { status: 'REPLIED', firstRepliedAt: context.now }, context.now);
  context.setTime(2_000_000);
  const media = { type: 'document', mimeType: 'application/pdf', fileName: 'reply.pdf', sizeBytes: 42 };
  const matched = await context.route('!pm reply', {
    quotedId: 'absent-source-reply',
    quoteBody: '权限配置已修复，请 M4 重新登录。',
    quoteSenderJid: '60444444444@c.us', quoteSentAt: 1_900_000, quoteMedia: media,
  });
  assert.equal(matched.value.ok, true);
  const prepared = handlerValue(matched);
  assert.equal(context.aiState.calls.length, 1);
  assert.equal(context.aiState.calls[0].candidates.length, 3);
  assert.ok(context.aiState.calls[0].candidates.every((row) => ['WAITING_TEVAU', 'REPLIED'].includes(row.status)));
  assert.equal(prepared.candidates.length, 3);
  assert.equal(prepared.session.ai_confidence, 'high');
  assert.equal(prepared.session.status, 'PENDING', 'high confidence must never auto-confirm');
  assert.equal(context.repositories.issues.listReplies(issues[0].id).length, 0);
  assert.match(prepared.session.token, /^[A-Za-z0-9_-]{16}$/u);
  assert.equal(prepared.session.expires_at - prepared.session.created_at, 15 * 60 * 1000);
  assert.equal(prepared.session.reply_text, '权限配置已修复，请 M4 重新登录。');
  assert.equal(prepared.session.source_sender_jid, '60444444444@c.us');
  assert.equal(prepared.session.source_sent_at, 1_900_000);
  assert.deepEqual(JSON.parse(prepared.session.source_media_json), media);
  assert.equal(prepared.session.source_message_id, null);
  prepared.session = context.repositories.replyMatches.get(prepared.session.id);
  assert.ok(prepared.session.suggestion_whatsapp_message_id);
  assert.match(lastOutput(context), /建议：TV\d+.*理由：权限与登录关键词完全对应.*信心：高/su);
  assert.match(lastOutput(context), /候选（3，最多 3 个）/u);

  const withoutBinding = await context.route(
    `!pm confirm-reply ${prepared.candidates[0].public_id}`
  );
  assert.equal(withoutBinding.value.ok, false);
  assert.equal(context.repositories.issues.listReplies(prepared.candidates[0].issue_id).length, 0);

  context.setTime(2_001_000);
  const confirmed = await context.route(
    `!pm confirm-reply ${prepared.candidates[0].public_id}`,
    { quotedId: prepared.session.suggestion_whatsapp_message_id, quoteBody: 'bot suggestion' }
  );
  assert.equal(confirmed.value.ok, true);
  const result = handlerValue(confirmed);
  assert.equal(result.issue.status, 'REPLIED');
  assert.equal(result.reply.source_whatsapp_message_id, 'absent-source-reply');
  assert.equal(result.reply.source_sender_jid, '60444444444@c.us');
  assert.equal(result.reply.source_sent_at, 1_900_000);
  assert.deepEqual(JSON.parse(result.reply.source_media_json), media);
  assert.equal(result.firstResponseDurationMs, result.issue.first_replied_at - result.issue.created_at);
  assert.equal(Object.hasOwn(result, 'waitingDurationMs'), false);
  assert.match(lastOutput(context), /首次响应耗时：/u);
  assert.doesNotMatch(lastOutput(context), /首次响应\/等待|当前等待/u);
  assert.match(lastOutput(context), new RegExp(`!pm resolve ${result.issue.public_id}`, 'u'));
  assert.equal(context.repositories.issues.search('M4 重新登录', { chatId: context.chat.id }).length, 1);

  const replayed = await context.route(
    `!pm confirm-reply ${prepared.session.token} ${result.issue.public_id}`
  );
  assert.equal(replayed.value.ok, true);
  assert.equal(handlerValue(replayed).replayed, true);
  assert.equal(context.repositories.issues.listReplies(result.issue.id).length, 1);
  assert.equal(context.repositories.issues.listEvents(result.issue.id)
    .filter((event) => event.event_type === 'REPLY_CONFIRMED').length, 1);
});

test('AI failure/no-match and send failure/restart always reuse a safe deterministic pending session without repeating AI', async (t) => {
  const context = fixture(t);
  for (let index = 1; index <= 6; index += 1) context.createIssue(index);
  context.setTime(3_000_000);

  context.aiState.response = () => ({
    ok: false, value: null, model: null, attempts: 2,
    error: { code: 'PROVIDER_FAILED', message: 'provider down' },
  });
  context.adapter.failNext = new Error('send failed');
  await assert.rejects(context.route('!pm reply', {
    id: 'send-retry-command', quotedId: 'reply-send-retry', quoteBody: '登录回复',
  }), /send failed/u);
  assert.equal(context.aiState.calls.length, 1);
  let session = context.repositories.replyMatches.findBySource(context.chat.id, 'reply-send-retry');
  assert.equal(session.status, 'PENDING');
  assert.equal(session.ai_status, 'FAILED');
  assert.equal(session.suggestion_whatsapp_message_id, null);
  assert.equal(context.repositories.replyMatches.listCandidates(session.id).length, 3);

  context.restartRuntime();
  const retry = await context.route('!pm reply', {
    id: 'send-retry-command', quotedId: 'reply-send-retry', quoteBody: '登录回复',
  });
  assert.equal(retry.value.ok, true);
  assert.equal(context.aiState.calls.length, 1, 'restart/send retry must not invoke AI again');
  session = context.repositories.replyMatches.get(session.id);
  assert.ok(session.suggestion_whatsapp_message_id);
  assert.match(lastOutput(context), /AI 未产生可靠结果/u);

  context.aiState.response = () => ({
    ok: true,
    value: {
      selectedPublicId: null, confidence: 'low', reason: '证据不足', rankedCandidates: [],
    },
    model: 'fake/no-match', attempts: 1, error: null,
  });
  const noMatch = await context.route('!pm reply', {
    quotedId: 'reply-no-match', quoteBody: '好的，收到。',
  });
  const noMatchResult = handlerValue(noMatch);
  assert.equal(noMatchResult.session.ai_status, 'NO_MATCH');
  assert.equal(noMatchResult.session.status, 'PENDING');
  assert.equal(noMatchResult.candidates.length, 3);
  assert.equal(context.repositories.issues.listReplies(noMatchResult.candidates[0].issue_id).length, 0);

  context.aiState.response = () => ({
    ok: true,
    value: {
      selectedPublicId: null, confidence: 'medium', reason: 'invalid uncertainty', rankedCandidates: [],
    },
    model: 'fake/invalid-no-match', attempts: 1, error: null,
  });
  const invalid = handlerValue(await context.route('!pm reply', {
    quotedId: 'reply-invalid-no-match', quoteBody: '无法确定对应工单。',
  }));
  assert.equal(invalid.session.ai_status, 'INVALID');
  assert.equal(invalid.session.ai_selected_public_id, null);
  assert.equal(invalid.session.ai_confidence, 'low');
  assert.equal(invalid.session.ai_error_code, 'AI_RESULT_INVALID');
  assert.equal(invalid.candidates.length, 3);
  assert.ok(invalid.candidates.every((candidate) => candidate.confidence === 0.25));
});

test('beforeAi authorization denial is preserved and only safely interrupts the created session', async (t) => {
  const context = fixture(t);
  for (let index = 1; index <= 3; index += 1) context.createIssue(index);
  context.setTime(3_500_000);
  context.permissions.beforeAi = () => {
    throw new AuthorizationError('ROLE_REQUIRED', 'AI permission was revoked');
  };

  const routed = await context.route('!pm reply', {
    quotedId: 'reply-ai-denied', quoteBody: '权限已修复。',
  });
  assert.equal(routed.value.ok, false);
  assert.ok(routed.value.error instanceof AuthorizationError);
  assert.equal(routed.value.error.code, 'ROLE_REQUIRED');
  assert.equal(context.aiState.calls.length, 0);
  const session = context.repositories.replyMatches.findBySource(context.chat.id, 'reply-ai-denied');
  assert.equal(session.status, 'PENDING');
  assert.equal(session.ai_status, 'FAILED');
  assert.equal(session.ai_error_code, 'AI_INTERRUPTED');
  assert.notEqual(session.ai_error_code, 'AI_CLIENT_FAILURE');
  assert.equal(session.suggestion_whatsapp_message_id, null);
  assert.equal(context.repositories.replyMatches.listCandidates(session.id).length, 3);
  assert.equal(context.adapter.sends.length, 1, 'only the authorization denial should be sent');
  assert.match(lastOutput(context), /无权限/u);
});

test('concurrent create race recovers a PROCESSING session as interrupted instead of wedging it', async (t) => {
  const context = fixture(t);
  for (let index = 1; index <= 3; index += 1) context.createIssue(index);
  context.setTime(3_600_000);
  const repository = context.repositories.replyMatches;
  const create = repository.create.bind(repository);
  let racedSessionId = null;
  repository.create = (input) => {
    const raced = create(input);
    racedSessionId = raced.record.id;
    repository.create = create;
    throw new Error('simulated concurrent source UNIQUE constraint');
  };

  const result = handlerValue(await context.route('!pm reply', {
    quotedId: 'reply-create-race', quoteBody: '并行匹配恢复测试。',
  }));
  assert.equal(result.session.id, racedSessionId);
  assert.equal(result.replayed, true);
  assert.equal(result.session.ai_status, 'FAILED');
  assert.equal(result.session.ai_error_code, 'AI_INTERRUPTED');
  assert.equal(context.repositories.replyMatches.listCandidates(racedSessionId).length, 3);
  assert.equal(context.aiState.calls.length, 0);
});

test('parallel sessions enforce configured Eric, token/candidate/chat binding, prompt quotes, cancellation, and durable expiry', async (t) => {
  const context = fixture(t);
  const issues = [];
  for (let index = 1; index <= 6; index += 1) issues.push(context.createIssue(index));
  context.setTime(4_000_000);

  const denied = await context.route('!pm reply', {
    senderJid: OTHER_ERIC, quotedId: 'unauthorized-reply', quoteBody: 'fix',
  });
  assert.equal(denied.value.ok, false);
  assert.equal(context.aiState.calls.length, 0);
  assert.equal(context.repositories.replyMatches.findBySource(context.chat.id, 'unauthorized-reply'), null);

  const first = handlerValue(await context.route('!pm reply', {
    senderJid: ERIC_ALIAS, quotedId: 'parallel-a', quoteBody: 'merchant login permission fixed A',
  }));
  const second = handlerValue(await context.route('!pm reply', {
    quotedId: 'parallel-b', quoteBody: 'merchant login permission fixed B',
  }));
  first.session = context.repositories.replyMatches.get(first.session.id);
  second.session = context.repositories.replyMatches.get(second.session.id);
  assert.notEqual(first.session.token, second.session.token);
  assert.equal(first.session.eric_jid, ERIC);

  const outside = issues.find((issue) => !first.candidates.some((candidate) => candidate.issue_id === issue.id));
  assert.ok(outside);
  let rejected = await context.route(
    `!pm confirm-reply ${first.session.token} ${outside.public_id}`
  );
  assert.equal(rejected.value.ok, false);
  assert.equal(context.repositories.replyMatches.get(first.session.id).status, 'PENDING');

  const quoteBound = await context.route(
    `!pm confirm-reply ${first.candidates[0].public_id}`,
    { quotedId: second.session.suggestion_whatsapp_message_id, quoteBody: 'other prompt' }
  );
  assert.equal(quoteBound.value.ok, true);
  assert.equal(handlerValue(quoteBound).session.id, second.session.id,
    'quoted prompt must bind the command to that exact session, never latest');
  assert.equal(context.repositories.replyMatches.get(first.session.id).status, 'PENDING');

  const foreign = context.repositories.replyMatches.create({
    sessionUid: 'foreign-session', token: 'FOREIGN_token_1234', chatId: context.otherChat.id,
    sourceWhatsappMessageId: 'foreign-source', ericJid: ERIC, replyText: 'foreign reply',
    candidates: [{ issueId: context.repositories.issues.create({
      issueUid: 'foreign-issue', eventUid: 'foreign-event', chatId: context.otherChat.id,
      title: 'Foreign issue', description: 'foreign', createdByJid: ERIC, now: 4_000_000,
    }).record.id, confidence: 1, reason: 'foreign' }],
    createdAt: 4_000_000, expiresAt: 5_000_000,
  }).record;
  rejected = await context.route(
    `!pm confirm-reply ${foreign.token} ${issues[0].public_id}`
  );
  assert.equal(rejected.value.ok, false);
  assert.equal(context.repositories.replyMatches.get(foreign.id).status, 'PENDING');

  const cancelled = await context.route('!pm cancel', {
    quotedId: first.session.suggestion_whatsapp_message_id, quoteBody: 'bot prompt',
  });
  assert.equal(cancelled.value.ok, true);
  assert.equal(context.repositories.replyMatches.get(first.session.id).status, 'CANCELLED');
  rejected = await context.route(
    `!pm confirm-reply ${first.session.token} ${first.candidates[0].public_id}`
  );
  assert.equal(rejected.value.ok, false);

  const expiring = handlerValue(await context.route('!pm reply', {
    quotedId: 'parallel-expiring', quoteBody: 'merchant login expiry test',
  }));
  context.setTime(expiring.session.expires_at + 1);
  rejected = await context.route(
    `!pm confirm-reply ${expiring.session.token} ${expiring.candidates[0].public_id}`
  );
  assert.equal(rejected.value.ok, false);
  assert.equal(context.repositories.replyMatches.get(expiring.session.id).status, 'EXPIRED');
});

test('successful suggestion send with failed DB binding is not resent and explicit token still confirms', async (t) => {
  const context = fixture(t);
  for (let index = 1; index <= 3; index += 1) context.createIssue(index);
  context.setTime(4_500_000);
  context.runtime.replyService.bindSuggestion = () => {
    throw new Error('simulated bindSuggestion database failure');
  };

  const routed = await context.route('!pm reply', {
    quotedId: 'reply-bind-degraded', quoteBody: '登录权限已修复。',
  });
  assert.equal(routed.value.ok, true);
  assert.equal(routed.value.degraded.code, 'RECEIPT_BIND_FAILED');
  assert.equal(context.adapter.sends.length, 1, 'a post-send binding failure must not send a duplicate');
  assert.equal(context.logs.length, 1);
  const prepared = handlerValue(routed);
  const session = context.repositories.replyMatches.get(prepared.session.id);
  assert.equal(session.suggestion_whatsapp_message_id, null);
  assert.match(lastOutput(context), new RegExp(session.token, 'u'));
  assert.match(lastOutput(context), /明文显示仅用于发送失败或重启后的恢复/u);

  context.setTime(4_501_000);
  const confirmed = await context.route(
    `!pm confirm-reply ${session.token} ${prepared.candidates[0].public_id}`
  );
  assert.equal(confirmed.value.ok, true);
  assert.equal(handlerValue(confirmed).issue.id, prepared.candidates[0].issue_id);
  assert.equal(context.repositories.issues.listReplies(prepared.candidates[0].issue_id).length, 1);
  assert.equal(context.adapter.sends.length, 2, 'confirmation adds one message, never a suggestion resend');
});

test('confirmation winning the race prevents later AI finalization and candidate replacement', (t) => {
  const context = fixture(t);
  const first = context.createIssue(1);
  const second = context.createIssue(2);
  context.setTime(4_700_000);
  const created = context.repositories.replyMatches.create({
    sessionUid: 'finalize-confirm-race', token: 'RACE_token_123456', chatId: context.chat.id,
    sourceWhatsappMessageId: 'finalize-confirm-source', ericJid: ERIC,
    replyText: 'race reply', aiStatus: 'PROCESSING',
    candidates: [
      { issueId: first.id, confidence: 0, reason: 'first deterministic' },
      { issueId: second.id, confidence: 0, reason: 'second deterministic' },
    ],
    createdAt: 4_700_000, expiresAt: 4_800_000,
  }).record;
  const confirmed = context.repositories.replyMatches.confirm({
    token: created.token, ericJid: ERIC, issueId: first.id,
    eventUid: 'finalize-confirm-event', replyUid: 'finalize-confirm-reply',
    reason: 'confirmation won', now: 4_700_100,
  });
  assert.equal(confirmed.session.status, 'CONFIRMED');
  const before = context.repositories.replyMatches.listCandidates(created.id)
    .map(({ issue_id: issueId, position, confidence, reason }) => ({ issueId, position, confidence, reason }));

  const finalized = context.repositories.replyMatches.finalizeAi({
    sessionId: created.id, aiStatus: 'MATCHED', selectedPublicId: second.public_id,
    confidence: 'high', reason: 'late AI result', model: 'fake/late', attempts: 1,
    candidates: [
      { issueId: second.id, confidence: 0.95, reason: 'late replacement' },
      { issueId: first.id, confidence: 0.25, reason: 'late fallback' },
    ],
    now: 4_700_200,
  });
  assert.equal(finalized.finalized, false);
  assert.equal(finalized.record.status, 'CONFIRMED');
  assert.equal(finalized.record.ai_status, 'PROCESSING');
  const after = context.repositories.replyMatches.listCandidates(created.id)
    .map(({ issue_id: issueId, position, confidence, reason }) => ({ issueId, position, confidence, reason }));
  assert.deepEqual(after, before);
  assert.throws(() => context.db.prepare(
    'DELETE FROM reply_match_candidates WHERE session_id = ?'
  ).run(created.id), /final reply candidates are immutable/u);
});

test('multiple confirmed replies preserve first response and admin move correction recomputes both issue states', async (t) => {
  const context = fixture(t);
  const sourceIssue = context.createIssue(1, { title: 'Source login', description: 'source' });
  const targetIssue = context.createIssue(2, { title: 'Target login', description: 'target' });
  context.createIssue(3);
  context.setTime(5_000_000);
  context.aiState.response = (candidates) => {
    const selected = candidates.find((candidate) => candidate.publicId === sourceIssue.public_id)
      || candidates[0];
    return {
      ok: true,
      value: {
        selectedPublicId: selected.publicId, confidence: 'high', reason: 'selected source',
        rankedCandidates: [{ publicId: selected.publicId, confidence: 'high', reason: 'selected' }],
      }, model: 'fake', attempts: 1, error: null,
    };
  };
  const first = handlerValue(await context.route('!pm reply', {
    quotedId: 'multiple-first', quoteBody: 'first source reply',
  }));
  const firstConfirmed = handlerValue(await context.route(
    `!pm confirm-reply ${first.session.token} ${first.candidates[0].public_id}`
  ));
  context.setTime(5_010_000);
  const second = handlerValue(await context.route('!pm reply', {
    quotedId: 'multiple-second', quoteBody: 'second source reply',
  }));
  const secondConfirmed = handlerValue(await context.route(
    `!pm confirm-reply ${second.session.token} ${second.candidates[0].public_id}`
  ));
  assert.equal(firstConfirmed.issue.id, secondConfirmed.issue.id);
  const beforeMove = context.repositories.issues.findById(firstConfirmed.issue.id);
  assert.equal(beforeMove.first_replied_at, firstConfirmed.reply.confirmed_at);
  assert.equal(context.repositories.issues.listReplies(beforeMove.id).length, 2);

  context.setTime(5_020_000);
  const moved = context.issueService.moveReply({
    chatJid: CHAT, actorJid: ADMIN,
    replyId: firstConfirmed.reply.id,
    toPublicId: targetIssue.public_id,
    sourceEventUid: 'task13-move-source', eventUid: 'task13-move-target',
    reason: 'AI matching correction',
  });
  assert.equal(moved.targetIssue.status, 'REPLIED');
  assert.equal(moved.targetIssue.first_replied_at, firstConfirmed.reply.confirmed_at);
  assert.equal(moved.sourceIssue.status, 'REPLIED');
  assert.equal(moved.sourceIssue.first_replied_at, secondConfirmed.reply.confirmed_at);
  assert.equal(context.repositories.issues.search('first source reply', { chatId: context.chat.id })[0].id,
    targetIssue.id);
  assert.equal(context.repositories.issues.search('second source reply', { chatId: context.chat.id })[0].id,
    sourceIssue.id);
});
