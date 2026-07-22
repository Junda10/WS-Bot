'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const JSZip = require('jszip');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { IssueService } = require('../services/issue-service');
const { PermissionService } = require('../services/permission-service');
const {
  AttachmentValidationError,
  assertPdfPageLimit,
  detectAttachmentType,
  limitExtractedText,
  sanitizeDisplayName,
} = require('../services/attachment-type');
const { AttachmentStorage, AttachmentStorageError } = require('../services/attachment-storage');
const {
  AttachmentProcessingQueue,
  QueueFullError,
} = require('../services/attachment-processing-queue');
const { AttachmentPreflightProcessor } = require('../services/attachment-preflight-processor');
const { AttachmentService } = require('../services/attachment-service');
const { MediaDownloadError, WhatsAppAdapter } = require('../whatsapp/adapter');

const CHAT_JID = '120300000000000000@g.us';
const OTHER_CHAT_JID = '120300000000000001@g.us';
const MEMBER_JID = '60111111111@c.us';
const STRANGER_JID = '60999999999@c.us';

const LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxPdfPages: 100,
  maxImagePixels: 40_000_000,
  maxDocxUncompressedBytes: 100 * 1024 * 1024,
  maxExtractedChars: 1_000_000,
  processingTimeoutMs: 1000,
  maxZipEntries: 10_000,
  maxDocxCompressionRatio: 100,
});

function png(width = 1, height = 1) {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function docx(text = 'hello') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('_rels/.rels', '<Relationships/>');
  zip.file('word/document.xml', `<document>${text}</document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-attachment-test-'));
  const archiveDir = path.join(root, 'archive');
  const tempDir = path.join(root, 'staging');
  const db = getDatabase({ filename: path.join(root, 'test.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({
    chatUid: 'attachment-chat', jid: CHAT_JID, timezone: 'UTC', now: 10,
  }).record;
  repositories.permissions.set({
    chatId: chat.id, canonicalJid: MEMBER_JID, role: 'MEMBER', now: 11,
  });
  let now = 1000;
  const clock = () => now++;
  const permissionService = new PermissionService({ repositories, authorizedChatJid: CHAT_JID });
  const issueService = new IssueService({ repositories, permissionService, clock });
  const storage = new AttachmentStorage({ rootDir: archiveDir, tempDir });
  const queue = new AttachmentProcessingQueue({
    concurrency: options.concurrency ?? 1,
    maxPending: options.maxPending ?? 100,
  });
  const adapter = options.adapter || {
    async downloadAttachment() { throw new Error('download not configured'); },
    async downloadQuotedAttachment() { throw new Error('quoted download not configured'); },
    async downloadAttachmentByMessageId() { throw new Error('retry download not configured'); },
  };
  const processor = options.processor || {
    async process(buffer, metadata, limits, { signal } = {}) {
      if (signal?.aborted) throw new Error('aborted');
      return {
        detected: await detectAttachmentType(buffer, metadata, limits),
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    },
  };
  const service = new AttachmentService({
    repositories, permissionService, issueService, storage, queue, adapter, processor,
    limits: { ...LIMITS, ...(options.limits || {}) }, clock, logger: { warn() {}, error() {} },
  });
  let messageNumber = 0;
  function message(extra = {}) {
    messageNumber += 1;
    return repositories.messages.create({
      whatsappMessageId: `wa-attachment-${messageNumber}`,
      chatId: chat.id,
      senderJid: MEMBER_JID,
      body: 'attachment', sentAt: now, receivedAt: now,
      ...extra,
    }).record;
  }
  function issue(suffix = String(messageNumber)) {
    return issueService.create({
      chatJid: CHAT_JID, actorJid: MEMBER_JID,
      issueUid: `attachment-issue-${suffix}`, eventUid: `attachment-event-${suffix}`,
      idempotencyKey: `attachment-create-${suffix}`, title: `Issue ${suffix}`,
      description: 'Attachment retry test',
    }).record;
  }
  function attachment(input = {}) {
    const source = input.message || message();
    return repositories.attachments.create({
      idempotencyKey: input.idempotencyKey || `${source.whatsapp_message_id}:media`,
      messageId: source.id,
      issueId: input.issueId,
      mediaWhatsappMessageId: input.mediaWhatsappMessageId || source.whatsapp_message_id,
      displayName: input.displayName || 'evidence.txt',
      declaredMime: input.declaredMime || 'text/plain',
      sizeBytes: input.sizeBytes ?? 0,
      retentionClass: input.issueId ? 'ISSUE' : 'TEMPORARY',
      processingStatus: input.processingStatus || 'PENDING', now: clock(),
    }).record;
  }
  t.after(async () => {
    service.stopRecovery();
    queue.stopAccepting();
    await queue.drain({ timeoutMs: 1000 });
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, archiveDir, tempDir, db, repositories, chat, permissionService,
    issueService, storage, queue, adapter, service, message, issue, attachment, clock,
  };
}

function downloadable(buffer, fileName = 'evidence.txt', mimeType = 'text/plain') {
  return { buffer, fileName, mimeType, sizeBytes: buffer.length };
}

test('allowlist uses bytes plus strict MIME/extension/UTF-8 policy and rejects executables', async () => {
  assert.equal((await detectAttachmentType(Buffer.from('valid UTF-8 文本'), {
    fileName: '../../notes.md', mimeType: 'text/markdown',
  }, LIMITS)).kind, 'markdown');
  assert.equal((await detectAttachmentType(png(), {
    fileName: 'photo.PNG', mimeType: 'application/octet-stream',
  }, LIMITS)).kind, 'png');
  assert.equal((await detectAttachmentType(Buffer.from('%PDF-1.7\nbody'), {
    fileName: 'report.pdf', mimeType: 'application/pdf',
  }, LIMITS)).kind, 'pdf');
  assert.equal((await detectAttachmentType(await docx(), {
    fileName: 'report.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, LIMITS)).kind, 'docx');

  const rejected = [
    [png(), { fileName: 'photo.pdf', mimeType: 'application/pdf' }, 'EXTENSION_MISMATCH'],
    [png(), { fileName: 'photo.png', mimeType: 'application/pdf' }, 'MIME_MISMATCH'],
    [Buffer.from('%PDF-1.4'), { fileName: 'legacy.doc', mimeType: 'application/pdf' }, 'LEGACY_DOC_REJECTED'],
    [Buffer.from('4d5a9000', 'hex'), { fileName: 'safe.txt', mimeType: 'text/plain' }, 'EXECUTABLE_REJECTED'],
    [Buffer.from([0xff, 0xfe, 0xfd]), { fileName: 'bad.txt', mimeType: 'text/plain' }, 'INVALID_UTF8'],
    [Buffer.from('plain text'), { fileName: 'no-extension', mimeType: 'text/plain' }, 'UNKNOWN_TYPE'],
  ];
  for (const [buffer, metadata, code] of rejected) {
    await assert.rejects(
      detectAttachmentType(buffer, metadata, LIMITS),
      (error) => error instanceof AttachmentValidationError && error.code === code
    );
  }
  assert.equal(sanitizeDisplayName('../../..\\secret/../notes.md'), 'notes.md');
});

test('byte/image/parser ceilings are reusable and DOCX ZIP bomb preflight never inflates entries', async () => {
  await assert.rejects(detectAttachmentType(Buffer.alloc(11, 0x61), {
    fileName: 'large.txt', mimeType: 'text/plain',
  }, { ...LIMITS, maxFileBytes: 10 }), (error) => error.code === 'FILE_TOO_LARGE');
  await assert.rejects(detectAttachmentType(png(10_000, 10_000), {
    fileName: 'huge.png', mimeType: 'image/png',
  }, { ...LIMITS, maxImagePixels: 1_000_000 }), (error) => error.code === 'IMAGE_PIXEL_LIMIT');
  const archive = await docx('x'.repeat(200));
  await assert.rejects(detectAttachmentType(archive, {
    fileName: 'bomb.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, { ...LIMITS, maxDocxUncompressedBytes: 30 }),
  (error) => error.code === 'DOCX_UNCOMPRESSED_LIMIT');
  assert.throws(() => assertPdfPageLimit(101, LIMITS), (error) => error.code === 'PDF_PAGE_LIMIT');
  assert.throws(() => limitExtractedText('123456', { maxExtractedChars: 5 }),
    (error) => error.code === 'EXTRACTED_TEXT_LIMIT');
});

test('private storage uses random/hash names, atomic staging, and rejects traversal/symlink roots', async (t) => {
  const context = fixture(t);
  const stage = await context.storage.stageBuffer(Buffer.from('%PDF-1.4'), { maxBytes: 100 });
  assert.ok(stage.path.startsWith(`${fs.realpathSync(context.tempDir)}${path.sep}`));
  const committed = await context.storage.commitStaged(stage, {
    sha256: 'a'.repeat(64), extension: 'pdf', issueId: 7,
  });
  assert.match(committed.storageKey, /^issues[/\\]7[/\\][a-f0-9]{64}-[a-f0-9-]+\.pdf$/u);
  assert.equal(fs.readFileSync(context.storage.resolve(committed.storageKey), 'utf8'), '%PDF-1.4');
  assert.throws(() => context.storage.resolve('../outside.pdf'), /escapes|invalid/u);

  const outside = path.join(context.root, 'outside.pdf');
  fs.writeFileSync(outside, 'outside');
  const escape = path.join(context.archiveDir, 'escape.pdf');
  fs.symlinkSync(outside, escape);
  assert.throws(() => context.storage.resolve('escape.pdf'), /unsafe|escapes|symlink/iu);

  const symlinkRoot = path.join(context.root, 'symlink-root');
  fs.symlinkSync(context.archiveDir, symlinkRoot, 'dir');
  assert.throws(() => new AttachmentStorage({
    rootDir: symlinkRoot, tempDir: path.join(context.root, 'another-temp'),
  }), /real directory/u);
});

test('SHA-256 dedupe stores one blob while preserving two sanitized attachment records', async (t) => {
  const context = fixture(t);
  const first = context.attachment({ displayName: '../../first.txt' });
  const second = context.attachment({ displayName: '..\\second.txt' });
  const payload = downloadable(Buffer.from('same UTF-8 content'));
  const [one, two] = await Promise.all([
    context.service.enqueue(first.id, async () => payload),
    context.service.enqueue(second.id, async () => payload),
  ]);
  assert.equal(one.deduplicated, false);
  assert.equal(two.deduplicated, true);
  const firstRow = context.repositories.attachments.findById(first.id);
  const secondRow = context.repositories.attachments.findById(second.id);
  assert.equal(firstRow.sha256, secondRow.sha256);
  assert.equal(firstRow.storage_key, secondRow.storage_key);
  assert.equal(secondRow.duplicate_of_attachment_id, first.id);
  assert.equal(firstRow.display_name, 'evidence.txt');
  assert.equal(context.db.prepare('SELECT count(*) AS count FROM attachment_blobs').get().count, 1);
  assert.equal(context.repositories.attachments.listAttempts(second.id)[0].status, 'SUCCEEDED');
});

test('temporary content promotes atomically into an issue archive without changing its hash', async (t) => {
  const context = fixture(t);
  const record = context.attachment();
  await context.service.enqueue(record.id, async () => downloadable(Buffer.from('promotion content')));
  const before = context.repositories.attachments.findById(record.id);
  assert.match(before.storage_key, /^temporary[/\\]/u);
  const issue = context.issue('promotion');
  await context.service.promoteToIssue({
    attachmentId: record.id,
    issueId: issue.id,
    chatJid: CHAT_JID,
    actorJid: MEMBER_JID,
  });
  const after = context.repositories.attachments.findById(record.id);
  assert.equal(after.issue_id, issue.id);
  assert.equal(after.sha256, before.sha256);
  assert.match(after.storage_key, new RegExp(`^issues[/\\\\]${issue.id}[/\\\\]`, 'u'));
  assert.ok(fs.existsSync(context.storage.resolve(after.storage_key)));
  assert.equal(context.repositories.attachments.findBlob(after.sha256).retention_class, 'ISSUE');
});

test('media expiry, download errors, timeout, disk write and atomic rename failures persist attempts', async (t) => {
  const context = fixture(t);
  const cases = [
    ['expired', () => Promise.reject(new MediaDownloadError('MEDIA_EXPIRED', 'expired')), 'MEDIA_EXPIRED', true],
    ['download', () => Promise.reject(new MediaDownloadError('DOWNLOAD_FAILED', 'network')), 'DOWNLOAD_FAILED', true],
  ];
  for (const [name, downloader, code, retryable] of cases) {
    const record = context.attachment({ idempotencyKey: `failure-${name}` });
    await assert.rejects(context.service.enqueue(record.id, downloader));
    const failed = context.repositories.attachments.findById(record.id);
    assert.equal(failed.processing_status, 'FAILED');
    assert.equal(failed.last_error_code, code);
    assert.equal(Boolean(failed.retryable), retryable);
    const attempt = context.repositories.attachments.listAttempts(record.id)[0];
    assert.equal(attempt.status, 'FAILED');
    assert.equal(attempt.error_code, code);
  }

  const timeoutService = new AttachmentService({
    repositories: context.repositories,
    permissionService: context.permissionService,
    issueService: context.issueService,
    storage: context.storage,
    queue: context.queue,
    adapter: context.adapter,
    processor: context.service.processor,
    limits: { ...LIMITS, processingTimeoutMs: 15 },
    clock: context.clock,
    logger: { warn() {}, error() {} },
  });
  const timed = context.attachment({ idempotencyKey: 'failure-timeout' });
  await assert.rejects(timeoutService.enqueue(
    timed.id,
    () => new Promise((resolve) => setTimeout(
      () => resolve(downloadable(Buffer.from('late'))),
      100
    ))
  ));
  assert.equal(context.repositories.attachments.findById(timed.id).last_error_code, 'PROCESSING_TIMEOUT');

  const originalStage = context.storage.stageBuffer.bind(context.storage);
  context.storage.stageBuffer = async () => {
    throw new AttachmentStorageError('DISK_WRITE_FAILED', 'disk full');
  };
  const disk = context.attachment({ idempotencyKey: 'failure-disk' });
  await assert.rejects(context.service.enqueue(
    disk.id, async () => downloadable(Buffer.from('disk content'))
  ), /disk full/u);
  assert.equal(context.repositories.attachments.findById(disk.id).last_error_code, 'DISK_WRITE_FAILED');
  context.storage.stageBuffer = originalStage;

  const originalCommit = context.storage.commitStaged.bind(context.storage);
  context.storage.commitStaged = async () => {
    throw new AttachmentStorageError('ATOMIC_ARCHIVE_FAILED', 'rename failed');
  };
  const atomic = context.attachment({ idempotencyKey: 'failure-atomic' });
  await assert.rejects(context.service.enqueue(
    atomic.id, async () => downloadable(Buffer.from('atomic content'))
  ), /rename failed/u);
  assert.equal(context.repositories.attachments.findById(atomic.id).last_error_code, 'ATOMIC_ARCHIVE_FAILED');
  context.storage.commitStaged = originalCommit;
});

test('serialized queue concurrency is one and retry-file service path is authorized and durable', async (t) => {
  let active = 0;
  let maxActive = 0;
  const retryPayload = downloadable(Buffer.from('retry succeeded'));
  const adapter = {
    lookups: 0,
    async downloadAttachment() { throw new MediaDownloadError('MEDIA_EXPIRED', 'expired'); },
    async downloadQuotedAttachment() { return retryPayload; },
    async downloadAttachmentByMessageId() {
      this.lookups += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return retryPayload;
    },
  };
  const context = fixture(t, { adapter });
  const issue = context.issue('retry');
  const first = context.attachment({ issueId: issue.id, idempotencyKey: 'retry-one' });
  const second = context.attachment({ issueId: issue.id, idempotencyKey: 'retry-two' });
  await Promise.allSettled([
    context.service.enqueue(first.id, () => adapter.downloadAttachment()),
    context.service.enqueue(second.id, () => adapter.downloadAttachment()),
  ]);
  assert.equal(context.repositories.attachments.findById(first.id).processing_status, 'FAILED');

  assert.throws(() => context.service.retryIssue({
    chatJid: OTHER_CHAT_JID, actorJid: MEMBER_JID, publicId: issue.public_id,
  }), /not allowed|not authorized/u);
  assert.throws(() => context.service.retryIssue({
    chatJid: CHAT_JID, actorJid: STRANGER_JID, publicId: issue.public_id,
  }), /role is required/u);
  assert.equal(adapter.lookups, 0, 'authorization must precede every media lookup');

  const retried = context.service.retryIssue({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: issue.public_id,
  });
  assert.deepEqual(retried.attachmentIds, [first.id, second.id]);
  await context.queue.drain({ timeoutMs: 1000 });
  assert.equal(maxActive, 1);
  assert.equal(adapter.lookups, 2);
  for (const attachmentId of retried.attachmentIds) {
    const row = context.repositories.attachments.findById(attachmentId);
    assert.equal(row.processing_status, 'UNPARSED');
    assert.equal(row.next_attempt_number, 3);
    assert.deepEqual(
      context.repositories.attachments.listAttempts(attachmentId).map((attempt) => attempt.status),
      ['FAILED', 'SUCCEEDED']
    );
  }
});

test('quoted attachment capture checks chat/member authorization before WhatsApp fetch/download', async (t) => {
  const payload = downloadable(Buffer.from('quoted text'), 'quoted.txt', 'text/plain');
  const adapter = {
    quotedCalls: 0,
    async downloadAttachment() { return payload; },
    async downloadAttachmentByMessageId() { return payload; },
    async downloadQuotedAttachment() { this.quotedCalls += 1; return payload; },
  };
  const context = fixture(t, { adapter });
  const command = context.message({ body: '!pm add' });
  const message = { async getQuotedMessage() { throw new Error('adapter owns fetch'); } };
  const base = {
    message,
    persisted: command,
    normalized: {
      id: command.whatsapp_message_id,
      chatJid: CHAT_JID,
      senderJid: MEMBER_JID,
      quoted: {
        id: 'quoted-media-id', chatJid: CHAT_JID,
        media: { fileName: '../../quoted.txt', mimeType: 'text/plain', sizeBytes: 11 },
      },
    },
  };
  assert.throws(() => context.service.captureQuoted({
    ...base,
    normalized: { ...base.normalized, chatJid: OTHER_CHAT_JID },
  }), /not allowed|not authorized/u);
  assert.throws(() => context.service.captureQuoted({
    ...base,
    normalized: { ...base.normalized, senderJid: STRANGER_JID },
  }), /role is required/u);
  assert.equal(adapter.quotedCalls, 0);

  const captured = context.service.captureQuoted(base);
  await captured.operation;
  assert.equal(adapter.quotedCalls, 1);
  const stored = context.repositories.attachments.findById(captured.attachment.id);
  assert.equal(stored.media_whatsapp_message_id, 'quoted-media-id');
  assert.equal(stored.display_name, 'quoted.txt');
  assert.equal(stored.processing_status, 'UNPARSED');
});

test('WhatsApp media decoder enforces actual bytes and distinguishes expiry/download failures', async () => {
  const client = { async sendMessage() {} };
  const adapter = new WhatsAppAdapter({ client });
  await assert.rejects(adapter.downloadAttachment({
    _data: { size: 100 }, async downloadMedia() { return null; },
  }, { maxBytes: 20 }), (error) => error.code === 'FILE_TOO_LARGE');
  await assert.rejects(adapter.downloadAttachment({
    _data: {}, async downloadMedia() { return null; },
  }, { maxBytes: 20 }), (error) => error.code === 'MEDIA_EXPIRED');
  await assert.rejects(adapter.downloadAttachment({
    _data: {}, async downloadMedia() { throw new Error('network reset'); },
  }, { maxBytes: 20 }), (error) => error.code === 'DOWNLOAD_FAILED');
  await assert.rejects(adapter.downloadAttachment({
    _data: {}, async downloadMedia() { return { data: Buffer.alloc(21).toString('base64') }; },
  }, { maxBytes: 20 }), (error) => error.code === 'FILE_TOO_LARGE');
});

test('identical UTF-8 bytes dedupe across .txt/.md while detection metadata remains per attachment', async (t) => {
  const context = fixture(t);
  const bytes = Buffer.from('# same bytes\n');
  const text = context.attachment({ displayName: 'same.txt', declaredMime: 'text/plain' });
  const markdown = context.attachment({ displayName: 'same.md', declaredMime: 'text/markdown' });
  const first = await context.service.enqueue(
    text.id, async () => downloadable(bytes, 'same.txt', 'text/plain')
  );
  const second = await context.service.enqueue(
    markdown.id, async () => downloadable(bytes, 'same.md', 'text/markdown')
  );
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  const textRow = context.repositories.attachments.findById(text.id);
  const markdownRow = context.repositories.attachments.findById(markdown.id);
  assert.equal(textRow.blob_sha256, markdownRow.blob_sha256);
  assert.deepEqual(
    [textRow.detected_mime, textRow.detected_extension],
    ['text/plain', 'txt']
  );
  assert.deepEqual(
    [markdownRow.detected_mime, markdownRow.detected_extension],
    ['text/markdown', 'md']
  );
  const blob = context.repositories.attachments.findBlob(textRow.blob_sha256);
  assert.equal(Object.hasOwn(blob, 'detected_mime'), false);
  assert.equal(Object.hasOwn(blob, 'detected_extension'), false);
});

test('shared temporary blob promotes once and crash recovery completes its durable intent', async (t) => {
  const context = fixture(t);
  const bytes = Buffer.from('shared promotion bytes');
  const first = context.attachment({ idempotencyKey: 'shared-promote-1' });
  const second = context.attachment({ idempotencyKey: 'shared-promote-2' });
  await context.service.enqueue(first.id, async () => downloadable(bytes));
  await context.service.enqueue(second.id, async () => downloadable(bytes));
  const issue = context.issue('shared-promotion');
  const originalKey = context.repositories.attachments.findById(first.id).storage_key;
  await context.service.promoteToIssue({
    attachmentId: first.id, issueId: issue.id, chatJid: CHAT_JID, actorJid: MEMBER_JID,
  });
  const promotedKey = context.repositories.attachments.findById(first.id).storage_key;
  assert.equal(promotedKey.startsWith(`issues${path.sep}${issue.id}${path.sep}`), true);
  assert.equal(context.repositories.attachments.findById(second.id).storage_key, promotedKey);
  assert.equal(fs.existsSync(path.join(context.archiveDir, originalKey)), false);
  await context.service.promoteToIssue({
    attachmentId: first.id, issueId: issue.id, chatJid: CHAT_JID, actorJid: MEMBER_JID,
  });
  assert.equal(context.repositories.attachments.findById(first.id).storage_key, promotedKey);

  const crashAttachment = context.attachment({ idempotencyKey: 'crash-promote' });
  await context.service.enqueue(
    crashAttachment.id,
    async () => downloadable(Buffer.from('crash promotion bytes'))
  );
  const crashIssue = context.issue('crash-promotion');
  const crashBlob = context.repositories.attachments.findBlob(
    context.repositories.attachments.findById(crashAttachment.id).blob_sha256
  );
  const targetKey = await context.storage.promotionTarget(crashBlob.storage_key, crashIssue.id);
  const intent = context.repositories.attachments.beginBlobPromotion({
    attachmentId: crashAttachment.id,
    issueId: crashIssue.id,
    targetKey,
    now: context.clock(),
  });
  await context.storage.reconcilePromotion(intent.blob.storage_key, targetKey);
  assert.equal(context.repositories.attachments.findBlob(crashBlob.sha256).storage_key, crashBlob.storage_key,
    'simulate crash after rename but before DB finalization');
  const recovery = await context.service.recoverPending();
  assert.deepEqual(recovery.promotionErrors, []);
  const reconciled = context.repositories.attachments.findBlob(crashBlob.sha256);
  assert.equal(reconciled.storage_key, targetKey);
  assert.equal(reconciled.promotion_target_key, null);
  assert.ok(fs.existsSync(context.storage.resolve(targetKey)));
});

test('blob cleanup counts soft-deleted references and hard-purges only eligible temporary history', async (t) => {
  const context = fixture(t);
  const bytes = Buffer.from('temporary purge bytes');
  const one = context.attachment({ idempotencyKey: 'purge-1' });
  const two = context.attachment({ idempotencyKey: 'purge-2' });
  await context.service.enqueue(one.id, async () => downloadable(bytes));
  await context.service.enqueue(two.id, async () => downloadable(bytes));
  const hash = context.repositories.attachments.findById(one.id).blob_sha256;
  context.repositories.attachments.softDelete(one.id, context.clock());
  assert.deepEqual(await context.service.cleanupBlob(hash), {
    removed: false, reason: 'REFERENCES_OR_MISSING',
  });
  assert.equal((await context.service.purgeTemporaryBlob(hash)).removed, false,
    'a live temporary attachment protects the shared blob');
  context.repositories.attachments.softDelete(two.id, context.clock());
  const purged = await context.service.purgeTemporaryBlob(hash);
  assert.equal(purged.removed, true);
  assert.deepEqual(purged.attachmentIds, [one.id, two.id]);
  assert.equal(context.repositories.attachments.findBlob(hash), null);
  assert.equal(context.repositories.attachments.findById(one.id, { includeDeleted: true }), null);

  const issue = context.issue('purge-protected');
  const evidence = context.attachment({ issueId: issue.id, idempotencyKey: 'purge-issue' });
  await context.service.enqueue(
    evidence.id,
    async () => downloadable(Buffer.from('issue retained bytes'))
  );
  const issueHash = context.repositories.attachments.findById(evidence.id).blob_sha256;
  context.repositories.attachments.softDelete(evidence.id, context.clock());
  assert.equal((await context.service.purgeTemporaryBlob(issueHash)).removed, false);
  assert.ok(context.repositories.attachments.findBlob(issueHash));
  assert.deepEqual(context.db.pragma('foreign_key_check'), []);
});

test('startup recovery reclaims future-leased prior claims but preserves live current admissions', async (t) => {
  let releaseCurrent;
  let announceCurrent;
  const currentStarted = new Promise((resolve) => { announceCurrent = resolve; });
  const currentGate = new Promise((resolve) => { releaseCurrent = resolve; });
  const adapter = {
    async downloadAttachment() { throw new Error('not used'); },
    async downloadQuotedAttachment() { throw new Error('not used'); },
    async downloadAttachmentByMessageId() {
      return downloadable(Buffer.from('recovered prior bytes'));
    },
  };
  const context = fixture(t, { adapter, limits: { processingTimeoutMs: 30_000 } });
  const current = context.attachment({ idempotencyKey: 'current-live' });
  const currentOperation = context.service.enqueue(current.id, async () => {
    announceCurrent();
    await currentGate;
    return downloadable(Buffer.from('current live bytes'));
  });
  await currentStarted;
  const currentRow = context.repositories.attachments.findById(current.id);
  assert.equal(currentRow.processing_status, 'PROCESSING');

  const prior = context.attachment({ idempotencyKey: 'prior-future-lease' });
  const priorClaim = context.repositories.attachments.claimForQueue({
    attachmentId: prior.id, claimId: 'dead-prior-process', now: context.clock(),
  });
  const oldAttempt = context.repositories.attachments.startAttempt({
    attachmentId: prior.id,
    claimId: priorClaim.processing_claim_id,
    operation: 'DOWNLOAD',
    leaseUntil: 999_999,
    idempotencyKey: 'dead-prior-attempt',
    now: context.clock(),
  }).record;
  const recovered = await context.service.recoverPending();
  assert.deepEqual(recovered.queued, [prior.id]);
  assert.deepEqual(recovered.inFlightAttachmentIds, []);
  assert.ok(recovered.nextLeaseUntil > context.clock());
  assert.equal(
    context.repositories.attachments.listAttempts(prior.id).find((row) => row.id === oldAttempt.id).status,
    'FAILED'
  );
  assert.equal(context.repositories.attachments.findById(current.id).processing_claim_id,
    currentRow.processing_claim_id, 'live current claim must not be reclaimed');
  releaseCurrent();
  await currentOperation;
  await context.queue.drain({ timeoutMs: 1000 });
  assert.equal(context.repositories.attachments.findById(prior.id).processing_status, 'UNPARSED');
});

test('retry reports an expired but still-running non-abortable job as in-flight, never newly queued', async (t) => {
  let release;
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = {
    lookups: 0,
    async downloadAttachment() { throw new Error('not used'); },
    async downloadQuotedAttachment() { throw new Error('not used'); },
    async downloadAttachmentByMessageId() { this.lookups += 1; return downloadable(Buffer.from('wrong')); },
  };
  const context = fixture(t, { adapter, limits: { processingTimeoutMs: 30_000 } });
  const issue = context.issue('hung-retry');
  const record = context.attachment({ issueId: issue.id, idempotencyKey: 'hung-retry-file' });
  const operation = context.service.enqueue(record.id, async () => {
    announce();
    await gate;
    return downloadable(Buffer.from('serialized completion'));
  });
  await started;
  context.db.prepare('UPDATE attachments SET processing_lease_until = 0 WHERE id = ?').run(record.id);
  const retry = context.service.retryIssue({
    chatJid: CHAT_JID, actorJid: MEMBER_JID, publicId: issue.public_id,
  });
  assert.deepEqual(retry.attachmentIds, []);
  assert.deepEqual(retry.inFlightAttachmentIds, [record.id]);
  assert.equal(adapter.lookups, 0);
  release();
  await operation;
  assert.equal(context.repositories.attachments.listAttempts(record.id).length, 1);
});

test('orphan cleanup quarantines symlinks and continues after per-file removal errors', async (t) => {
  const context = fixture(t);
  const firstStage = await context.storage.stageBuffer(Buffer.from('orphan one'));
  const first = await context.storage.commitStaged(firstStage, {
    sha256: '1'.repeat(64), extension: 'txt',
  });
  const secondStage = await context.storage.stageBuffer(Buffer.from('orphan two'));
  const second = await context.storage.commitStaged(secondStage, {
    sha256: '2'.repeat(64), extension: 'txt',
  });
  const outside = path.join(context.root, 'outside');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(context.archiveDir, 'unsafe-link'));
  const originalRemove = context.storage.remove.bind(context.storage);
  context.storage.remove = async (key) => {
    if (key === first.storageKey) throw new AttachmentStorageError('DISK_CLEANUP_FAILED', 'locked');
    return originalRemove(key);
  };
  const logs = [];
  const result = await context.storage.cleanupOrphans([], {
    logger: { warn: (line) => logs.push(line), error: (line) => logs.push(line) },
  });
  assert.deepEqual(result.removed, [second.storageKey]);
  assert.equal(result.quarantined.includes('unsafe-link'), true);
  assert.equal(result.errors.length, 1);
  assert.ok(logs.some((line) => /locked/u.test(line)));
  assert.ok(fs.existsSync(context.storage.resolve(first.storageKey)));
  context.storage.remove = originalRemove;
});

test('post-rename archive failure exposes destination and service retries failed unlink cleanup', async (t) => {
  const context = fixture(t);
  const originalPromises = context.storage.promises;
  let destinationUnlinks = 0;
  context.storage.promises = {
    ...originalPromises,
    async chmod(candidate, mode) {
      if (candidate.startsWith(`${context.archiveDir}${path.sep}`) && candidate.endsWith('.txt')) {
        throw Object.assign(new Error('chmod after rename failed'), { code: 'EIO' });
      }
      return originalPromises.chmod(candidate, mode);
    },
    async unlink(candidate) {
      if (candidate.startsWith(`${context.archiveDir}${path.sep}`)) {
        destinationUnlinks += 1;
        if (destinationUnlinks === 1) {
          throw Object.assign(new Error('first unlink failed'), { code: 'EBUSY' });
        }
      }
      return originalPromises.unlink(candidate);
    },
  };
  const record = context.attachment({ idempotencyKey: 'post-rename-failure' });
  await assert.rejects(
    context.service.enqueue(record.id, async () => downloadable(Buffer.from('post rename bytes'))),
    (error) => error.code === 'ATOMIC_ARCHIVE_FAILED'
      && error.destinationStorageKey
      && error.requiresReconciliation
  );
  assert.equal(destinationUnlinks, 2, 'service must retry destination cleanup');
  assert.equal(context.repositories.attachments.findById(record.id).last_error_code,
    'ATOMIC_ARCHIVE_FAILED');
  assert.deepEqual(await context.storage.listStorageKeys(), []);
  context.storage.promises = originalPromises;
});

test('preflight consumes Worker.terminate rejection when aborting', async () => {
  class RejectingTerminateWorker extends EventEmitter {
    postMessage() {}
    terminate() { return Promise.reject(new Error('terminate failed')); }
  }
  const processor = new AttachmentPreflightProcessor({ Worker: RejectingTerminateWorker });
  const controller = new AbortController();
  const processing = processor.process(Buffer.from('text'), {}, LIMITS, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(processing, (error) => error.name === 'AbortError');
});
