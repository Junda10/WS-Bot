'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createPmCommandHandlers,
  knownErrorMessage,
  parseKeyValues,
  resolveArchivedAttachmentPath,
} = require('../commands/pm-handler');
const {
  formatIssueDetail,
  formatPmHelp,
  splitWhatsAppText,
} = require('../commands/pm-formatters');
const { createCommandRouter } = require('../commands/router');
const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { IssueDomainError, IssueService } = require('../services/issue-service');
const { PermissionService } = require('../services/permission-service');
const { WhatsAppAdapter } = require('../whatsapp/adapter');
const { AuthorizedGroupIngress, createMessageEventHandler } = require('../whatsapp/ingress');

const CHAT_JID = '120300000000000000@g.us';
const MEMBER_JID = '60111111111@c.us';
const ERIC_JID = '60222222222@c.us';
const ADMIN_JID = '60333333333@c.us';

class FakeAdapter {
  constructor() {
    this.textSends = [];
    this.attachmentSends = [];
    this.failText = null;
    this.failAttachment = null;
  }

  async sendParts(chatJid, parts, options) {
    if (this.failText) {
      const error = this.failText;
      this.failText = null;
      throw error;
    }
    this.textSends.push({ chatJid, parts, options });
    return parts.map((part, index) => ({ id: `text-${this.textSends.length}-${index}`, part }));
  }

  async sendArchivedAttachment(chatJid, attachment, options) {
    if (this.failAttachment) {
      const error = this.failAttachment;
      this.failAttachment = null;
      throw error;
    }
    this.attachmentSends.push({ chatJid, attachment, options });
    return { id: `file-${this.attachmentSends.length}` };
  }
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-pm-command-test-'));
  const attachmentsDir = path.join(root, 'attachments');
  fs.mkdirSync(attachmentsDir);
  const db = getDatabase({ filename: path.join(root, 'test.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({
    chatUid: 'pm-command-chat', jid: CHAT_JID, timezone: 'Asia/Kuala_Lumpur', now: 10,
  }).record;
  for (const [jid, roles] of [
    [MEMBER_JID, ['MEMBER']],
    [ERIC_JID, ['MEMBER', 'ERIC']],
    [ADMIN_JID, ['ADMIN']],
  ]) {
    for (const role of roles) {
      repositories.permissions.set({ chatId: chat.id, canonicalJid: jid, role, now: 20 });
    }
  }

  let now = 1_000_000;
  let messageNumber = 0;
  const clock = () => now;
  const setTime = (value) => { now = value; };
  const permissions = new PermissionService({ repositories, authorizedChatJid: CHAT_JID });
  const issues = new IssueService({ repositories, permissionService: permissions, clock });
  const adapter = new FakeAdapter();
  const handlers = createPmCommandHandlers({
    issueService: issues,
    permissionService: permissions,
    adapter,
    attachmentsDir,
    clock,
    maxOutputLength: options.maxOutputLength,
  });
  const router = createCommandRouter({ permissionService: permissions, pmHandlers: handlers, clock });

  async function route(body, routeOptions = {}) {
    messageNumber += 1;
    const id = routeOptions.id || `pm-command-${messageNumber}`;
    const normalized = {
      id,
      chatJid: routeOptions.chatJid || CHAT_JID,
      senderJid: routeOptions.senderJid || MEMBER_JID,
      isGroup: true,
      body,
      quoted: routeOptions.quotedId ? {
        id: routeOptions.quotedId,
        chatJid: CHAT_JID,
      } : null,
    };
    const message = {
      body,
      reply: async (text) => {
        adapter.textSends.push({ chatJid: normalized.chatJid, parts: [text], fallback: true });
      },
    };
    const persisted = routeOptions.quotedId
      ? { quoted_whatsapp_message_id: routeOptions.quotedId }
      : null;
    return router.route(message, normalized, persisted);
  }

  function createIssue(suffix, extra = {}) {
    return issues.create({
      chatJid: CHAT_JID,
      actorJid: MEMBER_JID,
      issueUid: `issue-${suffix}`,
      eventUid: `event-created-${suffix}`,
      idempotencyKey: `create-${suffix}`,
      title: extra.title || `Issue ${suffix}`,
      description: extra.description || `Description ${suffix}`,
      sourceMessageId: extra.sourceMessageId,
      sourceWhatsappMessageId: extra.sourceWhatsappMessageId,
      reason: extra.reason || 'Test issue created',
    }).record;
  }

  function confirmReply(issue, suffix, replyText = `Tevau reply ${suffix}`) {
    repositories.replyMatches.create({
      sessionUid: `session-${suffix}`,
      token: `TOKEN-${suffix}`,
      chatId: chat.id,
      sourceWhatsappMessageId: `reply-source-${suffix}`,
      ericJid: ERIC_JID,
      replyText,
      candidates: [{ issueId: issue.id, confidence: 0.9, reason: 'test' }],
      createdAt: now,
      expiresAt: now + 10_000,
    });
    setTime(now + 100);
    return issues.confirmReply({
      chatJid: CHAT_JID,
      actorJid: ERIC_JID,
      token: `TOKEN-${suffix}`,
      publicId: issue.public_id,
      eventUid: `event-reply-${suffix}`,
      replyUid: `reply-${suffix}`,
    });
  }

  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    adapter, attachmentsDir, chat, createIssue, confirmReply, db, issues, permissions,
    repositories, root, route, setTime,
    get now() { return now; },
  };
}

function lastText(context) {
  return context.adapter.textSends.at(-1).parts.join('\n');
}

test('pure PM help, key=value parser, detail formatter, and deterministic splitter are bounded', () => {
  assert.match(formatPmHelp(), /list open/u);
  assert.match(formatPmHelp(), /attachment TV1.+同义别名/u);
  assert.match(formatPmHelp('admin'), /move-reply/u);
  assert.deepEqual({ ...parseKeyValues(['reason=中文 说明', 'note=a=b'], {
    allowed: ['reason', 'note'],
  }) }, { reason: '中文 说明', note: 'a=b' });
  assert.throws(() => parseKeyValues(['reason=a', 'reason=b'], {
    allowed: ['reason'],
  }), /不能重复/u);
  assert.throws(() => parseKeyValues(['__proto__=x'], {
    allowed: ['__proto__'],
  }), /不支持参数/u);

  const detail = formatIssueDetail({
    issue: {
      public_id: 'TV1', title: '标题', description: '问题', status: 'WAITING_TEVAU',
      owner_jid: null, created_at: 100, updated_at: 100, created_by_jid: MEMBER_JID,
      revision: 1, first_replied_at: null, firstResponseDurationMs: null,
      waitingDurationMs: 61_000, source_whatsapp_message_id: 'source', deleted_at: null,
    },
    replies: [], attachments: [], events: [],
  });
  assert.match(detail, /当前等待：1分钟/u);
  assert.match(detail, /首次响应：尚未收到/u);

  const long = `标题\n${'中文🙂'.repeat(300)}`;
  const first = splitWhatsAppText(long, { maxLength: 160 });
  const second = splitWhatsAppText(long, { maxLength: 160 });
  assert.deepEqual(first, second);
  assert.ok(first.length > 5);
  assert.ok(first.every((part) => part.length <= 160));
  assert.ok(first.every((part, index) => part.startsWith(`📄 ${index + 1}/${first.length}\n`)));
});

test('PM domain failures have explicit Chinese mappings', () => {
  for (const [code, expected] of [
    ['OWNER_NOT_MEMBER', '负责人必须是本群已启用的成员'],
    ['ILLEGAL_MOVE', '无法移动回复'],
    ['REPLY_SESSION_NOT_FOUND', '找不到本群的回复确认会话'],
    ['REPLY_CONFIRMATION_REJECTED', '回复确认已失效'],
  ]) {
    const message = knownErrorMessage(new IssueDomainError(code, 'RAW_ENGLISH_SENTINEL'));
    assert.match(message, new RegExp(expected, 'u'));
    assert.doesNotMatch(message, /RAW_ENGLISH_SENTINEL/u);
  }
});

test('list open returns all six issues oldest-waiting first with no five-item truncation', async (t) => {
  const context = fixture(t);
  const created = [];
  for (let index = 0; index < 6; index += 1) {
    context.setTime(1_000_000 + index * 1000);
    created.push(context.createIssue(`queue-${index}`));
  }
  context.setTime(2_000_000);
  const routed = await context.route('!pm list open');
  assert.equal(routed.value.ok, true);
  assert.equal(routed.value.value.length, 6);
  assert.deepEqual(routed.value.value.map((issue) => issue.public_id),
    created.map((issue) => issue.public_id));
  const output = lastText(context);
  for (const issue of created) assert.match(output, new RegExp(issue.public_id, 'u'));
});

test('show by TV/source includes issue, replies, attachment metadata, timeline, and response duration', async (t) => {
  const context = fixture(t);
  const source = context.repositories.messages.create({
    messageUid: 'source-message', whatsappMessageId: 'wa-source-message',
    chatId: context.chat.id, senderJid: MEMBER_JID, body: 'quoted problem source',
    sentAt: 900_000, receivedAt: 900_001,
  }).record;
  const issue = context.createIssue('full-show', {
    title: '登录权限故障', description: '商户登录持续返回 403',
    sourceMessageId: source.id, sourceWhatsappMessageId: source.whatsapp_message_id,
  });
  context.confirmReply(issue, 'full-show', '权限配置已修复，请重新登录。');
  context.repositories.attachments.create({
    attachmentUid: 'full-show-file', idempotencyKey: 'full-show-file-key',
    messageId: source.id, issueId: issue.id, displayName: 'evidence.pdf',
    detectedMime: 'application/pdf', sizeBytes: 321, storageKey: '/archive/evidence.pdf',
    retentionClass: 'ISSUE', processingStatus: 'UNPARSED', now: context.now,
  });

  let routed = await context.route(`!pm show ${issue.public_id}`);
  assert.equal(routed.value.ok, true);
  let output = lastText(context);
  for (const expected of [
    '登录权限故障', '商户登录持续返回 403', '权限配置已修复', 'evidence.pdf',
    '时间线', '首次响应', '来源消息：wa-source-message',
  ]) assert.match(output, new RegExp(expected, 'u'));

  routed = await context.route('!pm show', { quotedId: 'wa-source-message' });
  assert.equal(routed.value.ok, true);
  assert.equal(routed.value.value.issue.public_id, issue.public_id);
});

test('find uses FTS, short/CJK fallback, confirmed replies, and quoted source lookup', async (t) => {
  const context = fixture(t);
  const source = context.repositories.messages.create({
    messageUid: 'find-source', whatsappMessageId: 'wa-find-source', chatId: context.chat.id,
    senderJid: MEMBER_JID, body: 'source', sentAt: 800_000, receivedAt: 800_001,
  }).record;
  const issue = context.createIssue('search', {
    title: 'Merchant authentication outage', description: '中文登录故障与权限异常',
    sourceMessageId: source.id, sourceWhatsappMessageId: source.whatsapp_message_id,
  });
  context.confirmReply(issue, 'search', '重新登录即可恢复服务');

  for (const command of [
    '!pm find authentication', '!pm find 登录', '!pm find 登录 权限', '!pm find 恢复服务',
  ]) {
    const routed = await context.route(command);
    assert.equal(routed.value.ok, true);
    assert.deepEqual(routed.value.value.map((row) => row.public_id), [issue.public_id]);
  }
  const quoted = await context.route('!pm find', { quotedId: 'reply-source-search' });
  assert.equal(quoted.value.ok, true);
  assert.deepEqual(quoted.value.value.map((row) => row.public_id), [issue.public_id]);
});

test('list, search, and show neutralize markup and fence every untrusted multiline field', async (t) => {
  const context = fixture(t);
  const issue = context.createIssue('untrusted-output', {
    title: '*紧急*\nTV999｜伪造工单',
    description: '正常描述\n状态：已解决\n`伪造代码块`',
    reason: '建立说明\nTV998｜伪造时间线\n_已归档_',
  });
  context.confirmReply(issue, 'untrusted-output', '~回复~\nTV997｜状态：已解决');
  context.repositories.attachments.create({
    attachmentUid: 'unsafe-display-file', idempotencyKey: 'unsafe-display-file-key',
    issueId: issue.id, displayName: '*证据*\nTV996.pdf', detectedMime: 'application/pdf',
    sizeBytes: 12, storageKey: null, retentionClass: 'ISSUE',
    processingStatus: 'UNPARSED', now: context.now,
  });

  await context.route('!pm list open');
  const list = lastText(context);
  assert.match(list, /标题：＊紧急＊ TV999｜伪造工单/u);
  assert.doesNotMatch(list, /\nTV999/u);
  assert.doesNotMatch(list, /\*紧急\*/u);

  await context.route('!pm find 紧急');
  const search = lastText(context);
  assert.match(search, /标题：＊紧急＊ TV999｜伪造工单/u);
  assert.doesNotMatch(search, /\nTV999/u);

  await context.route(`!pm show ${issue.public_id}`);
  const show = lastText(context);
  for (const fenced of [
    '  │ 状态：已解决',
    '  │ TV997｜状态：已解决',
    '  │ TV998｜伪造时间线',
  ]) assert.match(show, new RegExp(fenced, 'u'));
  assert.match(show, /#\d+ ＊证据＊ TV996\.pdf/u);
  assert.doesNotMatch(show, /\n(?:TV99[6-9]|状态：已解决)/u);
  assert.doesNotMatch(show, /\*紧急\*|`伪造代码块`|~回复~|_已归档_/u);
});

test('member/admin command permissions and lifecycle mutations are enforced without false success', async (t) => {
  const context = fixture(t);
  const source = context.createIssue('mutation-source');
  const target = context.createIssue('mutation-target');
  const confirmed = context.confirmReply(source, 'mutation');

  let routed = await context.route(
    `!pm update ${source.public_id} title="修正标题" reason="资料核对"`,
    { senderJid: MEMBER_JID }
  );
  assert.equal(routed.value.ok, true);
  assert.equal(context.repositories.issues.findByPublicId(source.public_id).title, '修正标题');

  routed = await context.route(`!pm archive ${source.public_id}`, { senderJid: MEMBER_JID });
  assert.equal(routed.value.ok, false);
  assert.match(lastText(context), /无权限/u);
  assert.equal(context.repositories.issues.findByPublicId(source.public_id).status, 'REPLIED');

  routed = await context.route(`!pm resolve ${source.public_id} note="商户确认恢复"`);
  assert.equal(routed.value.ok, true);
  routed = await context.route(`!pm archive ${source.public_id}`, { senderJid: ADMIN_JID });
  assert.equal(routed.value.ok, true);
  routed = await context.route(`!pm restore ${source.public_id}`, { senderJid: ADMIN_JID });
  assert.equal(routed.value.ok, true);
  assert.equal(context.repositories.issues.findByPublicId(source.public_id).status, 'RESOLVED');

  routed = await context.route(
    `!pm move-reply ${source.public_id} ${target.public_id} reply=${confirmed.reply.id} reason="纠错"`,
    { senderJid: ADMIN_JID }
  );
  assert.equal(routed.value.ok, true);
  assert.equal(context.repositories.replyMatches.findReply(confirmed.reply.id).current_issue_id, target.id);

  routed = await context.route(`!pm delete ${target.public_id} reason="重复"`, {
    senderJid: ADMIN_JID,
  });
  assert.equal(routed.value.ok, true);
  assert.equal(context.repositories.issues.findByPublicId(target.public_id), null);
  routed = await context.route(`!pm restore ${target.public_id}`, { senderJid: ADMIN_JID });
  assert.equal(routed.value.ok, true);
});

test('deleted/not-found and malformed bounded options return explicit failure and make no mutation', async (t) => {
  const context = fixture(t);
  const issue = context.createIssue('deleted');
  await context.route(`!pm delete ${issue.public_id} reason="test"`, { senderJid: ADMIN_JID });

  let routed = await context.route(`!pm show ${issue.public_id}`);
  assert.equal(routed.value.ok, false);
  assert.match(lastText(context), /找不到工单/u);
  routed = await context.route(`!pm show ${issue.public_id} deleted=true`, { senderJid: ADMIN_JID });
  assert.equal(routed.value.ok, true);
  assert.match(lastText(context), /已软删除/u);
  routed = await context.route('!pm show TV999');
  assert.equal(routed.value.ok, false);

  const before = context.repositories.issues.findByPublicId(issue.public_id, { includeDeleted: true });
  routed = await context.route(`!pm update ${issue.public_id} title=a title=b`);
  assert.equal(routed.value.ok, false);
  assert.match(lastText(context), /不能重复/u);
  const after = context.repositories.issues.findByPublicId(issue.public_id, { includeDeleted: true });
  assert.equal(after.revision, before.revision);
});

test('attachment resend accepts only existing in-root files and rejects path/symlink escapes before adapter', async (t) => {
  const context = fixture(t);
  const issue = context.createIssue('attachment');
  const validPath = path.join(context.attachmentsDir, 'report.docx');
  fs.writeFileSync(validPath, 'archived report');
  const attachment = context.repositories.attachments.create({
    attachmentUid: 'resend-file', idempotencyKey: 'resend-file-key', issueId: issue.id,
    displayName: 'report.docx', detectedMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 456, storageKey: 'report.docx', retentionClass: 'ISSUE',
    processingStatus: 'UNPARSED', now: context.now,
  }).record;

  let routed = await context.route(`!pm resend-file ${issue.public_id} ${attachment.id}`);
  assert.equal(routed.value.ok, true);
  assert.equal(context.adapter.attachmentSends.length, 1);
  assert.equal(context.adapter.attachmentSends[0].chatJid, CHAT_JID);
  assert.equal(context.adapter.attachmentSends[0].attachment.path, fs.realpathSync(validPath));
  assert.equal(context.adapter.attachmentSends[0].attachment.displayName, 'report.docx');

  routed = await context.route(`!pm resend-file ${issue.public_id} ${attachment.id}`, {
    senderJid: '60999999999@c.us',
  });
  assert.equal(routed.value.ok, false);
  assert.equal(context.adapter.attachmentSends.length, 1);

  const outsidePath = path.join(context.root, 'outside.docx');
  fs.writeFileSync(outsidePath, 'outside');
  fs.symlinkSync(outsidePath, path.join(context.attachmentsDir, 'escape-link.docx'));
  const unsafeKeys = [
    ['absolute', outsidePath],
    ['outside', '../outside.docx'],
    ['symlink', 'escape-link.docx'],
    ['missing', 'missing.docx'],
  ];
  for (const [name, storageKey] of unsafeKeys) {
    const unsafe = context.repositories.attachments.create({
      attachmentUid: `unsafe-${name}`, idempotencyKey: `unsafe-${name}-key`, issueId: issue.id,
      displayName: `${name}.docx`, detectedMime: 'application/octet-stream',
      sizeBytes: 7, storageKey, retentionClass: 'ISSUE',
      processingStatus: 'UNPARSED', now: context.now,
    }).record;
    routed = await context.route(`!pm resend-file ${issue.public_id} ${unsafe.id}`);
    assert.equal(routed.value.ok, false, `${name} storage key must be rejected`);
    assert.match(lastText(context), /路径不安全|归档文件缺失/u);
    assert.equal(context.adapter.attachmentSends.length, 1, `${name} must fail before adapter`);
  }
  assert.throws(
    () => resolveArchivedAttachmentPath('report.docx', 'relative/archive'),
    /explicit absolute path/u
  );

  context.adapter.failAttachment = new Error('WhatsApp media outage');
  await assert.rejects(
    context.route(`!pm resend-file ${issue.public_id} ${attachment.id}`),
    /WhatsApp media outage/u
  );
  assert.doesNotMatch(lastText(context), /已重发|成功/u);
});

test('ingress integration persists command and routes actual chat/sender JIDs through services', async (t) => {
  const context = fixture(t);
  const issue = context.createIssue('ingress');
  const client = {
    sends: [],
    async sendMessage(chatJid, content, options) {
      this.sends.push({ chatJid, content, options });
      return { id: { _serialized: `sent-${this.sends.length}` }, timestamp: 1001 };
    },
  };
  const adapter = new WhatsAppAdapter({ client });
  const handlers = createPmCommandHandlers({
    issueService: context.issues,
    permissionService: context.permissions,
    adapter,
    attachmentsDir: context.attachmentsDir,
    clock: () => 1_000_000,
  });
  const router = createCommandRouter({
    permissionService: context.permissions,
    pmHandlers: handlers,
    clock: () => 1_000_000,
  });
  const ingress = new AuthorizedGroupIngress({
    repositories: context.repositories,
    permissionService: context.permissions,
    route: (message, normalized, persisted) => router.route(message, normalized, persisted),
    clock: () => 1_000_000,
  });
  const dispatch = createMessageEventHandler({
    ingress,
    adapter,
    routeLegacy: async () => { throw new Error('legacy must not run'); },
    clock: () => 1_000_000,
  });

  const result = await dispatch({
    id: { _serialized: 'real-ingress-command-id' },
    from: CHAT_JID,
    to: '60999999999@c.us',
    author: MEMBER_JID,
    fromMe: false,
    timestamp: 1000,
    body: `!pm show ${issue.public_id}`,
    hasMedia: false,
    type: 'chat',
    _data: {},
  });
  assert.equal(result.duplicate, false);
  assert.equal(client.sends[0].chatJid, CHAT_JID);
  assert.match(client.sends[0].content, new RegExp(issue.public_id, 'u'));
  assert.equal(client.sends[0].options.quotedMessageId, 'real-ingress-command-id');
  const stored = context.repositories.messages.findByWhatsappId('real-ingress-command-id');
  assert.equal(stored.sender_jid, MEMBER_JID);
  assert.equal(stored.processing_status, 'PROCESSED');
});

test('long show output splits stably within limits and text-send failure retries mutation idempotently', async (t) => {
  const context = fixture(t, { maxOutputLength: 300 });
  const issue = context.createIssue('long', {
    title: '长详情',
    description: Array.from({ length: 120 }, (_, index) => `第${index}行：${'内容🙂'.repeat(8)}`).join('\n'),
  });
  let routed = await context.route(`!pm show ${issue.public_id}`);
  assert.equal(routed.value.ok, true);
  const firstParts = context.adapter.textSends.at(-1).parts;
  assert.ok(firstParts.length > 5);
  assert.ok(firstParts.every((part) => part.length <= 300));
  assert.match(firstParts[0], /^📄 1\/\d+\n/u);
  assert.ok(firstParts.some((part) => /时间线/u.test(part)));

  const commandId = 'retry-same-whatsapp-command';
  context.adapter.failText = new Error('temporary WhatsApp text outage');
  await assert.rejects(
    context.route(`!pm update ${issue.public_id} title="只更新一次"`, { id: commandId }),
    /temporary WhatsApp text outage/u
  );
  const afterFailure = context.repositories.issues.findByPublicId(issue.public_id);
  assert.equal(afterFailure.title, '只更新一次');
  routed = await context.route(`!pm update ${issue.public_id} title="只更新一次"`, { id: commandId });
  assert.equal(routed.value.ok, true);
  const afterRetry = context.repositories.issues.findByPublicId(issue.public_id);
  assert.equal(afterRetry.revision, afterFailure.revision, 'retry must reuse the committed audit event');
  assert.equal(context.repositories.issues.listEvents(issue.id).filter((event) => event.event_type === 'UPDATED').length, 1);
});
