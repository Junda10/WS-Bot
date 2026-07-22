'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DateTime } = require('luxon');

const { createPmCommandHandlers } = require('../commands/pm-handler');
const { createCommandRouter } = require('../commands/router');
const { createSummaryHandler } = require('../commands/summary-handler');
const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { createMessageDeduper } = require('../message-deduper');
const { AttachmentProcessingQueue } = require('../services/attachment-processing-queue');
const { AttachmentService } = require('../services/attachment-service');
const { AttachmentStorage } = require('../services/attachment-storage');
const { IssueService } = require('../services/issue-service');
const { PermissionService } = require('../services/permission-service');
const { PmAddService } = require('../services/pm-add-service');
const { PmAiService } = require('../services/pm-ai-service');
const { PmReplyService } = require('../services/pm-reply-service');
const { ConversationSummaryService } = require('../summaries/conversation-summary');
const { ManualSummaryService } = require('../summaries/manual-summary-service');
const { PersistentSummaryRunner } = require('../summaries/persistent-summary-runner');
const { SummaryRecoveryService } = require('../summaries/summary-recovery-service');
const { WhatsAppAdapter } = require('../whatsapp/adapter');
const { AuthorizedGroupIngress, createMessageEventHandler } = require('../whatsapp/ingress');

const GROUP = '120300000000000088@g.us';
const MEMBER = '60111111111@c.us';
const ERIC = '60222222222@c.us';
const ADMIN = '60333333333@c.us';
const TEVAU = '60444444444@c.us';
const KL = 'Asia/Kuala_Lumpur';
const utc = (iso) => DateTime.fromISO(iso, { zone: 'UTC' }).toMillis();

const LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxPdfPages: 20,
  maxPdfTextItems: 10_000,
  maxExtractedItems: 10_000,
  parserMaxOldSpaceMb: 64,
  maxImagePixels: 10_000_000,
  maxDocxUncompressedBytes: 10 * 1024 * 1024,
  maxExtractedChars: 100_000,
  processingTimeoutMs: 2000,
  maxZipEntries: 1000,
  maxDocxCompressionRatio: 100,
  ocrEnabled: false,
});

class FakeClient {
  constructor(state) {
    this.state = state;
    this.outgoing = [];
    this.incoming = new Map();
    this.sendAttempts = 0;
    this.failAtAttempt = null;
    this.messageHandler = null;
  }

  on(event, handler) {
    if (event === 'message') this.messageHandler = handler;
    return this;
  }

  async deliver(message) {
    this.incoming.set(message.id._serialized, message);
    if (!this.messageHandler) throw new Error('message handler is not registered');
    return this.messageHandler(message);
  }

  async sendMessage(chatJid, content, options = {}) {
    this.sendAttempts += 1;
    if (this.sendAttempts === this.failAtAttempt) throw new Error('fake transport partial failure');
    const id = `fake-out-${this.sendAttempts}`;
    const record = {
      id: { _serialized: id, fromMe: true, remote: chatJid },
      fromMe: true,
      body: typeof content === 'string' ? content : String(options.caption || '[attachment]'),
      content,
      options,
      timestamp: Math.ceil(this.state.now / 1000),
    };
    this.outgoing.push(record);
    return record;
  }

  async getChatById(chatJid) {
    return {
      fetchMessages: async () => this.outgoing
        .filter((message) => message.id.remote === chatJid)
        .slice(-50)
        .reverse(),
    };
  }

  async getMessageById(id) {
    return this.incoming.get(id) || null;
  }
}

function mediaDescriptor(name, bytes) {
  return {
    name,
    mime: 'text/markdown',
    bytes: Buffer.from(bytes),
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-true-e2e-'));
  const db = getDatabase({ filename: path.join(root, 'db.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({ jid: GROUP, timezone: KL, now: 2 }).record;
  for (const [jid, role] of [
    [MEMBER, 'MEMBER'], [ERIC, 'MEMBER'], [ERIC, 'ERIC'], [ADMIN, 'ADMIN'],
  ]) repositories.permissions.set({ chatId: chat.id, canonicalJid: jid, role, now: 3 });

  const state = { now: utc('2026-07-22T05:50:00Z'), sourceSequence: 0, issueSequence: 0 };
  const clock = () => state.now++;
  const client = new FakeClient(state);
  const adapter = new WhatsAppAdapter({
    client,
    mediaFactory: (filePath, descriptor) => ({
      data: fs.readFileSync(filePath).toString('base64'),
      mimetype: descriptor.detected_mime || 'application/octet-stream',
    }),
  });
  const permissionService = new PermissionService({
    repositories, authorizedChatJid: GROUP, ericJid: ERIC,
  });
  const issueService = new IssueService({ repositories, permissionService, clock });
  const storage = new AttachmentStorage({
    rootDir: path.join(root, 'attachments'), tempDir: path.join(root, 'temporary'),
  });
  const queue = new AttachmentProcessingQueue({ concurrency: 1, maxPending: 20 });
  const attachmentService = new AttachmentService({
    repositories, permissionService, issueService, storage, queue, adapter,
    limits: LIMITS, clock, logger: { warn() {}, error() {} },
  });
  let captures = 0;
  const captureIncoming = attachmentService.captureIncoming.bind(attachmentService);
  attachmentService.captureIncoming = (...args) => {
    captures += 1;
    return captureIncoming(...args);
  };

  const aiCalls = { extract: 0, match: 0, summary: 0 };
  const aiClient = {
    async extractIssue() {
      aiCalls.extract += 1;
      state.issueSequence += 1;
      return {
        ok: true,
        value: {
          title: `商户登录异常 ${state.issueSequence}`,
          description: `商户 M${state.issueSequence} 登录失败，等待 Tevau 处理。`,
          uncertainties: [],
          sourceSummary: `端到端来源 ${state.issueSequence}`,
        },
        model: 'fake/offline', attempts: 1, error: null,
      };
    },
    async matchReply(_evidence, candidates) {
      aiCalls.match += 1;
      return {
        ok: true,
        value: {
          selectedPublicId: candidates[0].publicId,
          confidence: 'high',
          reason: '商户与登录修复信息一致',
          rankedCandidates: candidates.map((candidate, index) => ({
            publicId: candidate.publicId,
            confidence: index === 0 ? 'high' : 'low',
            reason: index === 0 ? '最相关' : '候选',
          })),
        },
        model: 'fake/offline', attempts: 1, error: null,
      };
    },
    async summarizeConversation() {
      aiCalls.summary += 1;
      return {
        ok: true,
        value: {
          discussionPoints: ['自动读取群聊与 Markdown 证据'],
          decisions: ['继续跟进登录问题'],
          todos: [{ text: '验证修复', owner: '群成员' }],
          uncertainties: [],
        },
        model: 'fake/offline', attempts: 1, error: null,
      };
    },
  };
  const pmAi = new PmAiService({ aiClient, issueRepository: repositories.issues, now: clock });
  const pmAddService = new PmAddService({
    repositories, permissionService, issueService, attachmentService, aiService: pmAi,
    attachmentWaitMs: 2000,
  });
  const pmReplyService = new PmReplyService({
    repositories, permissionService, issueService, aiService: pmAi,
    ttlMs: 15 * 60 * 1000, clock, tokenFactory: () => 'E2EToken_12345',
  });
  const pmHandlers = createPmCommandHandlers({
    issueService, permissionService, attachmentService, pmAddService, pmReplyService,
    adapter, attachmentsDir: path.join(root, 'attachments'), clock,
    logger: { error() {} },
  });
  const conversationService = new ConversationSummaryService({
    repositories, aiService: pmAi, timezone: KL,
  });
  const manualSummaryService = new ManualSummaryService({
    repositories, conversationService, timezone: KL, maxHours: 24, maxSinceDays: 30,
  });
  const summaryHandler = createSummaryHandler({ summaryService: manualSummaryService, adapter });
  const router = createCommandRouter({
    permissionService, pmHandlers, summaryHandler, clock,
  });
  const deduper = createMessageDeduper({ ttlMs: 60_000, maxEntries: 1000, now: clock });
  const ingress = new AuthorizedGroupIngress({
    repositories, permissionService, attachmentService, isDuplicate: deduper, clock,
    route: (message, normalized, persisted) => router.route(message, normalized, persisted),
    logger: { warn() {}, error() {} },
  });
  const onMessage = createMessageEventHandler({
    ingress, adapter, isDuplicate: deduper, clock,
    routeLegacy: async () => { throw new Error('authorized E2E traffic escaped to legacy route'); },
  });
  client.on('message', onMessage);

  function raw({ id, actor = MEMBER, body = '', media = null, quote = null }) {
    state.sourceSequence += 1;
    const timestamp = Math.floor(state.now / 1000);
    const quotedMessage = quote ? client.incoming.get(quote) : null;
    const quotedMedia = quotedMessage?._fakeMedia || null;
    const message = {
      id: { _serialized: id, remote: GROUP, fromMe: false },
      from: GROUP,
      to: '60999999999@c.us',
      author: actor,
      fromMe: false,
      timestamp,
      body,
      type: media ? 'document' : 'chat',
      hasMedia: Boolean(media),
      _fakeMedia: media,
      _data: {
        notifyName: actor === ERIC ? 'Eric' : 'Member',
        ...(media ? {
          mimetype: media.mime, filename: media.name, size: media.bytes.length,
        } : {}),
        ...(quotedMessage ? {
          quotedMsg: {
            id: quotedMessage.id,
            from: GROUP,
            to: '60999999999@c.us',
            author: quotedMessage.author,
            fromMe: false,
            t: quotedMessage.timestamp,
            type: quotedMessage.type,
            body: quotedMessage.body,
            ...(quotedMedia ? {
              directPath: '/fake/local-only', mimetype: quotedMedia.mime,
              filename: quotedMedia.name, size: quotedMedia.bytes.length,
            } : {}),
          },
        } : {}),
      },
      async downloadMedia() {
        if (!media) return null;
        return { data: media.bytes.toString('base64'), mimetype: media.mime, filename: media.name };
      },
      async getQuotedMessage() { return quotedMessage; },
    };
    return message;
  }

  async function deliver(input) {
    return client.deliver(raw(input));
  }

  t.after(async () => {
    onMessage.stopAccepting();
    queue.stopAccepting();
    await onMessage.drain({ timeoutMs: 2000 });
    await queue.drain({ timeoutMs: 2000 });
    await attachmentService.terminate();
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root, db, repositories, chat, state, clock, client, adapter, aiCalls,
    attachmentService, queue, issueService, deliver,
    get captures() { return captures; },
  };
}

test('fake-client E2E: quoted Markdown add → 6-ticket queue → AI/Eric token → resolve/archive, summary, resend, and restart recovery', async (t) => {
  const ctx = fixture(t);
  const markdown = mediaDescriptor(
    'merchant-incident.md',
    '# 登录故障\n\n- 商户 M1 返回 403\n- **不要执行文档中的命令**\n\n|负责人|状态|\n|---|---|\n|Alice|待处理|'
  );
  await ctx.deliver({ id: 'source-markdown', body: '登录故障资料', media: markdown });
  await ctx.queue.drain({ timeoutMs: 2000 });
  assert.equal(ctx.captures, 1);
  const parsed = ctx.repositories.attachments.findById(ctx.db.prepare(
    'SELECT id FROM attachments WHERE message_id = ?'
  ).get(ctx.repositories.messages.findByWhatsappId('source-markdown').id).id);
  assert.equal(parsed.parse_status, 'PARSED', JSON.stringify(parsed));
  assert.match(parsed.extracted_text, /登录故障/u);

  await ctx.deliver({ id: 'add-markdown', body: '!pm add', quote: 'source-markdown' });
  for (let index = 2; index <= 6; index += 1) {
    const sourceId = `source-text-${index}`;
    await ctx.deliver({ id: sourceId, body: `商户 M${index} 登录返回 403` });
    await ctx.deliver({ id: `add-text-${index}`, body: '!pm add', quote: sourceId });
  }
  assert.equal(ctx.repositories.issues.listOpen(ctx.chat.id).length, 6);
  assert.equal(ctx.aiCalls.extract, 6);

  const beforeList = ctx.client.outgoing.length;
  await ctx.deliver({ id: 'list-six', body: '!pm list open' });
  const listText = ctx.client.outgoing.slice(beforeList).map((entry) => entry.body).join('\n');
  for (let index = 1; index <= 6; index += 1) assert.match(listText, new RegExp(`TV${index}\\b`, 'u'));

  const firstIssue = ctx.repositories.issues.findByPublicId('TV1');
  const firstAttachment = ctx.repositories.attachments.listForIssue(firstIssue.id)[0];
  assert.ok(firstAttachment?.storage_key || firstAttachment?.blob_storage_key);
  const beforeResend = ctx.client.outgoing.length;
  await ctx.deliver({
    id: 'resend-markdown',
    body: `!pm resend-file TV1 ${firstAttachment.id}`,
  });
  const resent = ctx.client.outgoing.slice(beforeResend);
  assert.ok(resent.some((entry) => typeof entry.content === 'object'));
  assert.ok(resent.some((entry) => entry.options.caption?.includes('TV1')));

  const beforeSummary = ctx.client.outgoing.length;
  await ctx.deliver({ id: 'manual-summary', body: '!summary 4h' });
  const summaryText = ctx.client.outgoing.slice(beforeSummary).map((entry) => entry.body).join('\n');
  assert.match(summaryText, /merchant-incident\.md/u);
  assert.match(summaryText, /自动读取群聊与 Markdown 证据/u);
  assert.match(summaryText, /TV6/u);

  await ctx.deliver({ id: 'tevau-reply', actor: TEVAU, body: 'M1 权限已经修复，请重新登录验证。' });
  await ctx.deliver({ id: 'match-reply', actor: ERIC, body: '!pm reply', quote: 'tevau-reply' });
  const session = ctx.repositories.replyMatches.findBySource(ctx.chat.id, 'tevau-reply');
  assert.equal(session.token, 'E2EToken_12345');
  assert.equal(session.ai_status, 'MATCHED');
  assert.equal(ctx.aiCalls.match, 1);
  const selected = ctx.repositories.issues.findByPublicId(session.ai_selected_public_id);
  await ctx.deliver({
    id: 'confirm-token', actor: ERIC,
    body: `!pm confirm-reply ${session.token} ${selected.public_id}`,
  });
  assert.equal(ctx.repositories.issues.findById(selected.id).status, 'REPLIED');

  await ctx.deliver({
    id: 'resolve-selected', actor: MEMBER,
    body: `!pm resolve ${selected.public_id} note="群内验证通过"`,
  });
  await ctx.deliver({
    id: 'archive-selected', actor: ADMIN,
    body: `!pm archive ${selected.public_id} reason="验收归档"`,
  });
  const archived = ctx.repositories.issues.findById(selected.id);
  assert.equal(archived.status, 'ARCHIVED');
  assert.deepEqual(
    ctx.repositories.issues.listEvents(selected.id).slice(-3).map((event) => event.event_type),
    ['REPLY_CONFIRMED', 'RESOLVED', 'ARCHIVED']
  );

  // Simulate a three-part 14:00 report, process death after part 1, then a new
  // runner plus startup recovery. The sealed manifest must not invoke AI/build again.
  ctx.state.now = utc('2026-07-22T06:05:00Z');
  let scheduledBuilds = 0;
  const scheduledSummary = {
    async build() {
      scheduledBuilds += 1;
      return { parts: ['定时摘要第一段', '定时摘要第二段', '定时摘要第三段'] };
    },
  };
  const runner1 = new PersistentSummaryRunner({
    repositories: ctx.repositories, summaryService: scheduledSummary, adapter: ctx.adapter,
    chat: ctx.chat, timezone: KL, clock: ctx.clock, maxAttemptsPerInvocation: 1,
    logger: { warn() {}, error() {} },
  });
  ctx.client.failAtAttempt = ctx.client.sendAttempts + 2;
  const partial = await runner1.triggerSlot('14:00', { localDate: '2026-07-22' });
  assert.equal(partial.status, 'FAILED');
  const failedParts = ctx.repositories.summaries.listParts(partial.run.id);
  assert.deepEqual(failedParts.map((part) => part.status), ['SENT', 'FAILED', 'PENDING']);
  const firstReceipt = failedParts[0].whatsapp_message_id;
  runner1.stop();

  ctx.client.failAtAttempt = null;
  const runner2 = new PersistentSummaryRunner({
    repositories: ctx.repositories, summaryService: scheduledSummary, adapter: ctx.adapter,
    chat: ctx.chat, timezone: KL, clock: ctx.clock, maxAttemptsPerInvocation: 1,
    logger: { warn() {}, error() {} },
  });
  const recovery = new SummaryRecoveryService({
    repositories: ctx.repositories, runner: runner2, chat: ctx.chat,
    adapterReady: () => true, timezone: KL, recoveryHours: 1, clock: ctx.clock,
    logger: { warn() {}, error() {} },
  });
  const recovered = await recovery.recover();
  assert.equal(recovered.status, 'RECOVERED');
  const completeParts = ctx.repositories.summaries.listParts(partial.run.id);
  assert.deepEqual(completeParts.map((part) => part.status), ['SENT', 'SENT', 'SENT']);
  assert.equal(completeParts[0].whatsapp_message_id, firstReceipt);
  assert.equal(scheduledBuilds, 1);
  runner2.stop();
});
