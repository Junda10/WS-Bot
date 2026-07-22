'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { createMessageDeduper } = require('../message-deduper');
const { createDebouncedSmartReplyScheduler } = require('../services/debounced-smart-reply');
const { QueueFullError } = require('../services/attachment-processing-queue');
const { PermissionService } = require('../services/permission-service');
const { WhatsAppAdapter } = require('../whatsapp/adapter');
const { AuthorizedGroupIngress, createMessageEventHandler } = require('../whatsapp/ingress');
const { normalizeMessage } = require('../whatsapp/normalize-message');

const GROUP_JID = '120300000000000000@g.us';
const OTHER_GROUP_JID = '120300000000000001@g.us';
const USER_JID = '60111111111@c.us';
const BOT_JID = '60999999999@c.us';
const LID_JID = 'member-runtime@lid';

function rawMessage(overrides = {}) {
  const from = overrides.from || USER_JID;
  const timestamp = overrides.timestamp ?? 1_720_000_000;
  return {
    id: { _serialized: overrides.id || `false_${from}_${timestamp}` },
    from,
    to: '60999999999@c.us',
    author: overrides.author,
    fromMe: false,
    timestamp,
    body: overrides.body ?? 'hello',
    hasMedia: overrides.hasMedia || false,
    type: overrides.type || 'chat',
    _data: overrides._data || {},
    ...overrides,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-whatsapp-test-'));
  const db = getDatabase({ filename: path.join(root, 'db.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({
    chatUid: 'authorized-chat', jid: GROUP_JID, timezone: 'Asia/Kuala_Lumpur', now: 10,
  }).record;
  const permissionService = new PermissionService({ repositories, authorizedChatJid: GROUP_JID });
  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db, repositories, chat, permissionService };
}

class FakeClient {
  constructor() {
    this.sends = [];
    this.nextId = 1;
  }

  async sendMessage(chatJid, content, options) {
    this.sends.push({ chatJid, content, options });
    return {
      id: { _serialized: `sent-${this.nextId++}` },
      timestamp: 1_720_000_100,
    };
  }
}

test('normalizer handles direct/group JIDs, serialized IDs, UTC timestamps, quotes, and media without I/O', () => {
  const direct = normalizeMessage(rawMessage({
    id: 'direct-id', from: USER_JID.toUpperCase(), timestamp: 1_720_000_000,
  }), { receivedAt: 1_720_000_000_500 });
  assert.equal(direct.id, 'direct-id');
  assert.equal(direct.chatJid, USER_JID);
  assert.equal(direct.senderJid, USER_JID);
  assert.equal(direct.isGroup, false);
  assert.equal(direct.sentAt, 1_720_000_000_000);
  assert.equal(direct.receivedAt, 1_720_000_000_500);

  let downloads = 0;
  let quoteFetches = 0;
  const quotedData = {
    id: { _serialized: 'quoted-id', remote: GROUP_JID, participant: USER_JID },
    from: GROUP_JID,
    author: USER_JID,
    body: 'quoted evidence',
    t: 1_719_999_900,
    type: 'chat',
  };
  const group = normalizeMessage(rawMessage({
    id: 'group-media-id',
    from: GROUP_JID.toUpperCase(),
    author: LID_JID.toUpperCase(),
    body: '!pm add',
    hasMedia: true,
    type: 'document',
    timestamp: 1_720_000_001,
    downloadMedia: async () => { downloads += 1; },
    getQuotedMessage: async () => { quoteFetches += 1; },
    _data: {
      notifyName: '  小明\u0000 ',
      mimetype: 'application/pdf', filename: 'evidence.pdf', size: 12345,
      pageCount: 3, quotedMsg: quotedData,
    },
  }), { receivedAt: 1_720_000_001_250 });

  assert.equal(group.chatJid, GROUP_JID);
  assert.equal(group.senderJid, LID_JID);
  assert.equal(group.senderDisplayName, '小明');
  assert.equal(group.isCommand, true);
  assert.equal(group.type, 'MEDIA');
  assert.deepEqual(group.media, {
    type: 'document', mimeType: 'application/pdf', fileName: 'evidence.pdf',
    sizeBytes: 12345, width: null, height: null, durationSeconds: null,
    pageCount: 3, isViewOnce: false,
  });
  assert.deepEqual(group.quoted, {
    id: 'quoted-id', chatJid: GROUP_JID, senderJid: USER_JID, fromMe: false,
    body: 'quoted evidence', sentAt: 1_719_999_900_000, media: null,
  });
  assert.equal(downloads, 0, 'normalization must not download media');
  assert.equal(quoteFetches, 0, 'normalization must not fetch quoted content');
});

test('normalizer uses real whatsapp-web.js quoted id.remote/from/to/fromMe semantics', () => {
  const outboundBotQuote = normalizeMessage(rawMessage({
    id: 'command-quoting-bot', from: GROUP_JID, author: USER_JID,
    body: '!pm add', timestamp: 1_720_000_020,
    _data: {
      quotedMsg: {
        id: {
          fromMe: true,
          remote: GROUP_JID,
          id: 'BOT_MESSAGE_KEY',
          _serialized: `true_${GROUP_JID}_BOT_MESSAGE_KEY`,
        },
        from: { _serialized: BOT_JID },
        to: { _serialized: GROUP_JID },
        t: 1_720_000_010,
        type: 'document',
        caption: 'bot-supplied evidence',
        directPath: '/v/t62.7119/example',
        mimetype: 'application/pdf',
        filename: 'bot-proof.pdf',
        size: 4567,
        pageCount: 4,
      },
    },
  }), { receivedAt: 1_720_000_020_100 });

  assert.equal(outboundBotQuote.quoted.id, `true_${GROUP_JID}_BOT_MESSAGE_KEY`);
  assert.equal(outboundBotQuote.quoted.chatJid, GROUP_JID, 'id.remote is the conversation');
  assert.equal(outboundBotQuote.quoted.senderJid, BOT_JID, 'from is the bot sender when fromMe');
  assert.equal(outboundBotQuote.quoted.fromMe, true);
  assert.equal(outboundBotQuote.quoted.body, 'bot-supplied evidence');
  assert.deepEqual(outboundBotQuote.quoted.media, {
    type: 'document', mimeType: 'application/pdf', fileName: 'bot-proof.pdf',
    sizeBytes: 4567, width: null, height: null, durationSeconds: null,
    pageCount: 4, isViewOnce: false,
  });

  const incomingQuote = normalizeMessage(rawMessage({
    id: 'command-quoting-member', from: GROUP_JID, author: LID_JID,
    body: '!pm add', timestamp: 1_720_000_030,
    _data: {
      quotedMsg: {
        id: { fromMe: false, remote: GROUP_JID, _serialized: 'incoming-member-quote' },
        from: GROUP_JID,
        to: BOT_JID,
        author: { _serialized: LID_JID },
        t: 1_720_000_025,
        type: 'chat', body: 'member evidence',
      },
    },
  }), { receivedAt: 1_720_000_030_100 });
  assert.equal(incomingQuote.quoted.chatJid, GROUP_JID);
  assert.equal(incomingQuote.quoted.senderJid, LID_JID);
  assert.equal(incomingQuote.quoted.fromMe, false);
});

test('adapter sends text, ordered parts, quoted replies, and archived attachments through a fake client', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-adapter-send-test-'));
  const archivedPath = path.join(root, 'archive.bin');
  fs.writeFileSync(archivedPath, 'archive');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new FakeClient();
  const mediaCalls = [];
  const adapter = new WhatsAppAdapter({
    client,
    mediaFactory: async (filePath, descriptor) => {
      mediaCalls.push({ filePath, descriptor });
      return { data: 'base64', mimetype: 'application/octet-stream' };
    },
  });

  const textReceipt = await adapter.sendText(GROUP_JID.toUpperCase(), 'one', {
    quotedMessageId: 'quoted-1',
  });
  assert.equal(textReceipt.id, 'sent-1');
  assert.equal(textReceipt.sentAt, 1_720_000_100_000);
  await adapter.sendParts(GROUP_JID, ['two', 'three'], { quotedMessageId: 'quoted-parts' });
  const attachmentReceipt = await adapter.sendArchivedAttachment(GROUP_JID, {
    path: archivedPath, displayName: 'report.bin', id: 9,
  }, { caption: 'archived evidence' });

  assert.equal(attachmentReceipt.id, 'sent-4');
  assert.deepEqual(client.sends.map((send) => send.chatJid), Array(4).fill(GROUP_JID));
  assert.equal(client.sends[0].options.quotedMessageId, 'quoted-1');
  assert.equal(client.sends[1].options.quotedMessageId, 'quoted-parts');
  assert.equal(client.sends[2].options.quotedMessageId, undefined);
  assert.equal(client.sends[3].content.filename, 'report.bin');
  assert.equal(client.sends[3].options.sendMediaAsDocument, true);
  assert.equal(client.sends[3].options.caption, 'archived evidence');
  assert.equal(mediaCalls[0].filePath, archivedPath);
});

test('wrapIncoming preserves text reply return/options and delegates rich content', async () => {
  const client = new FakeClient();
  const richCalls = [];
  const richResult = { delegated: true };
  const raw = rawMessage({
    id: 'reply-source', from: GROUP_JID, author: USER_JID,
    reply: async (...args) => {
      richCalls.push(args);
      return richResult;
    },
  });
  const normalized = normalizeMessage(raw, { receivedAt: 1_720_000_000_100 });
  const wrapped = new WhatsAppAdapter({ client }).wrapIncoming(raw, normalized);

  const textResult = await wrapped.reply('text reply', OTHER_GROUP_JID, {
    quotedMessageId: 'caller-cannot-override', linkPreview: false,
  });
  assert.equal(textResult.id._serialized, 'sent-1', 'return the underlying WhatsApp Message');
  assert.deepEqual(client.sends[0], {
    chatJid: OTHER_GROUP_JID,
    content: 'text reply',
    options: { quotedMessageId: 'reply-source', linkPreview: false },
  });

  const media = { mimetype: 'image/png', data: 'base64' };
  assert.equal(await wrapped.reply(media, undefined, { caption: 'proof' }), richResult);
  assert.deepEqual(richCalls[0], [media, undefined, { caption: 'proof' }]);
  assert.equal(client.sends.length, 1, 'rich reply must be delegated, not coerced to text');
});

test('authorized ingress persists before routing and stores quote/media metadata without download', async (t) => {
  const { repositories, permissionService, chat } = fixture(t);
  const quoted = repositories.messages.create({
    messageUid: 'quoted-message', whatsappMessageId: 'quoted-db-id', chatId: chat.id,
    senderJid: USER_JID, body: 'earlier', sentAt: 1_720_000_000_000,
    receivedAt: 1_720_000_000_001,
  }).record;
  const client = new FakeClient();
  const adapter = new WhatsAppAdapter({ client });
  let downloads = 0;
  const routeObservations = [];
  const deduper = createMessageDeduper();
  const ingress = new AuthorizedGroupIngress({
    repositories,
    permissionService,
    isDuplicate: deduper,
    route: async (message, normalized, persisted) => {
      routeObservations.push({
        persistedBeforeRoute: Boolean(repositories.messages.findByWhatsappId(normalized.id)),
        persisted,
      });
      await message.reply('legacy ok');
    },
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: ingress.route, isDuplicate: deduper,
    clock: () => 1_720_000_100_000,
  });
  const raw = rawMessage({
    id: 'authorized-media-id', from: GROUP_JID, author: LID_JID,
    body: 'document caption', hasMedia: true, type: 'document',
    timestamp: 1_720_000_050,
    downloadMedia: async () => { downloads += 1; },
    _data: {
      notifyName: '文档成员',
      mimetype: 'text/markdown', filename: 'notes.md', filesize: 42,
      quotedMsg: {
        id: { _serialized: quoted.whatsapp_message_id }, from: GROUP_JID,
        author: USER_JID, body: 'earlier', t: 1_720_000_000,
      },
    },
  });

  const result = await handler(raw);
  assert.equal(result.duplicate, false);
  assert.equal(routeObservations.length, 1);
  assert.equal(routeObservations[0].persistedBeforeRoute, true);
  const persisted = repositories.messages.findByWhatsappId('authorized-media-id');
  assert.equal(persisted.chat_id, chat.id);
  assert.equal(persisted.sender_jid, LID_JID);
  assert.equal(persisted.sender_display_name, '文档成员');
  assert.equal(persisted.quoted_message_id, quoted.id);
  assert.equal(persisted.quoted_whatsapp_message_id, quoted.whatsapp_message_id);
  assert.equal(persisted.quoted_body, 'earlier');
  assert.equal(persisted.quoted_sender_jid, USER_JID);
  assert.equal(persisted.quoted_sent_at, 1_720_000_000_000);
  assert.equal(persisted.quoted_media_json, null);
  assert.equal(persisted.message_type, 'MEDIA');
  assert.equal(persisted.processing_status, 'PROCESSED');
  assert.equal(persisted.processing_attempt_count, 1);
  const attachment = repositories.attachments.db.prepare(
    'SELECT * FROM attachments WHERE message_id = ?'
  ).get(persisted.id);
  assert.equal(attachment.display_name, 'notes.md');
  assert.equal(attachment.declared_mime, 'text/markdown');
  assert.equal(attachment.detected_mime, null);
  assert.equal(attachment.media_whatsapp_message_id, 'authorized-media-id');
  assert.equal(attachment.size_bytes, 42);
  assert.equal(attachment.processing_status, 'PENDING');
  assert.equal(downloads, 0);
  assert.equal(client.sends.length, 1);
  assert.equal(client.sends[0].options.quotedMessageId, 'authorized-media-id');
});

test('memory fast filter and SQLite durable claim prevent duplicate and restart replay side effects', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const client = new FakeClient();
  const adapter = new WhatsAppAdapter({ client });
  const raw = rawMessage({
    id: 'duplicate-command-id', from: GROUP_JID, author: USER_JID,
    body: '!news', timestamp: 1_720_000_010,
  });
  let sideEffects = 0;
  const route = async (message) => {
    sideEffects += 1;
    await message.reply('business side effect');
  };

  const firstDeduper = createMessageDeduper();
  const firstIngress = new AuthorizedGroupIngress({
    repositories, permissionService, route, isDuplicate: firstDeduper,
  });
  const firstHandler = createMessageEventHandler({
    ingress: firstIngress, adapter, routeLegacy: route, isDuplicate: firstDeduper,
    clock: () => 1_720_000_020_000,
  });
  assert.equal((await firstHandler(raw)).duplicate, false);
  assert.equal((await firstHandler(raw)).source, 'memory');

  // Simulate process restart: the in-memory filter is empty, but the same SQLite
  // database remains authoritative and prevents command/send replay.
  const restartedDeduper = createMessageDeduper();
  const restartedIngress = new AuthorizedGroupIngress({
    repositories, permissionService, route, isDuplicate: restartedDeduper,
  });
  const restartedHandler = createMessageEventHandler({
    ingress: restartedIngress, adapter, routeLegacy: route, isDuplicate: restartedDeduper,
    clock: () => 1_720_000_030_000,
  });
  const replay = await restartedHandler(raw);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.source, 'sqlite');
  assert.equal(sideEffects, 1);
  assert.equal(client.sends.length, 1);
  assert.equal(repositories.messages.db.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE whatsapp_message_id='duplicate-command-id'"
  ).get().count, 1);
});

test('failed routes remain retryable across redelivery/restart and stale leases are reclaimed', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const adapter = new WhatsAppAdapter({ client: new FakeClient() });
  const raw = rawMessage({
    id: 'retryable-command', from: GROUP_JID, author: USER_JID,
    body: '!news', timestamp: 1_720_000_040,
  });
  let now = 1_720_000_050_000;
  let routes = 0;
  const deduper = createMessageDeduper();
  const route = async () => {
    routes += 1;
    if (routes === 1) throw new Error('temporary route outage');
  };
  const ingress = new AuthorizedGroupIngress({
    repositories, permissionService, route, isDuplicate: deduper,
    clock: () => now, processingLeaseMs: 100,
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: route, isDuplicate: deduper, clock: () => now,
  });

  await assert.rejects(handler(raw), /temporary route outage/);
  let row = repositories.messages.findByWhatsappId('retryable-command');
  assert.equal(row.processing_status, 'FAILED');
  assert.equal(row.processing_attempt_count, 1);
  assert.match(row.processing_last_error, /temporary route outage/);

  // The same process's memory filter must not hide unfinished work.
  assert.equal((await handler(raw)).duplicate, false);
  row = repositories.messages.findByWhatsappId('retryable-command');
  assert.equal(row.processing_status, 'PROCESSED');
  assert.equal(row.processing_attempt_count, 2);
  assert.equal(routes, 2);

  // Simulate a process dying after claim but before route. A fresh ingress may
  // not claim the live lease, then reclaims it exactly at expiry.
  const staleRaw = rawMessage({
    id: 'stale-processing-command', from: GROUP_JID, author: USER_JID,
    body: '!news', timestamp: 1_720_000_049,
  });
  const normalized = normalizeMessage(staleRaw, { receivedAt: now });
  const chat = permissionService.assertAuthorizedChat(GROUP_JID);
  const stalePersisted = ingress.persist(normalized, chat).record;
  repositories.messages.claimProcessing(stalePersisted.id, {
    claimId: 'dead-process', now, leaseMs: 100,
  });

  const restartedDeduper = createMessageDeduper();
  const restartedIngress = new AuthorizedGroupIngress({
    repositories, permissionService, route: async () => { routes += 1; },
    isDuplicate: restartedDeduper, clock: () => now, processingLeaseMs: 100,
  });
  const restarted = createMessageEventHandler({
    ingress: restartedIngress, adapter, routeLegacy: route,
    isDuplicate: restartedDeduper, clock: () => now,
  });
  assert.equal((await restarted(staleRaw)).source, 'sqlite-processing');
  now += 100;
  assert.equal((await restarted(staleRaw)).duplicate, false);
  row = repositories.messages.findByWhatsappId('stale-processing-command');
  assert.equal(row.processing_status, 'PROCESSED');
  assert.equal(row.processing_attempt_count, 2);
});

test('atomic claim prevents concurrent duplicate routes', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const adapter = new WhatsAppAdapter({ client: new FakeClient() });
  let releaseRoute;
  const routeGate = new Promise((resolve) => { releaseRoute = resolve; });
  let routes = 0;
  const ingress = new AuthorizedGroupIngress({
    repositories,
    permissionService,
    route: async () => { routes += 1; await routeGate; },
    isDuplicate: createMessageDeduper(),
    clock: () => 1_720_000_100_000,
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: ingress.route,
    clock: () => 1_720_000_100_000,
  });
  const raw = rawMessage({
    id: 'concurrent-command', from: GROUP_JID, author: USER_JID,
    body: '!news', timestamp: 1_720_000_090,
  });

  const first = handler(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await handler(raw);
  assert.equal(second.duplicate, true);
  assert.equal(second.source, 'ingress-processing');
  assert.equal(routes, 1);
  releaseRoute();
  assert.equal((await first).duplicate, false);
  assert.equal(repositories.messages.findByWhatsappId(raw.id).processing_status, 'PROCESSED');
});

test('out-of-order quoted evidence snapshot survives source absence and repository restart', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const adapter = new WhatsAppAdapter({ client: new FakeClient() });
  const ingress = new AuthorizedGroupIngress({
    repositories, permissionService, route: async () => {},
    clock: () => 1_720_000_200_000,
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: async () => {}, clock: () => 1_720_000_200_000,
  });
  const command = rawMessage({
    id: 'pm-add-out-of-order', from: GROUP_JID, author: USER_JID,
    body: '!pm add', timestamp: 1_720_000_190,
    _data: {
      quotedMsg: {
        id: { fromMe: true, remote: GROUP_JID, _serialized: 'missing-bot-source' },
        from: BOT_JID, to: GROUP_JID, t: 1_720_000_180,
        type: 'document', caption: 'restart-safe evidence',
        directPath: '/media/path', mimetype: 'text/markdown',
        filename: 'evidence.md', size: 321,
      },
    },
  });

  await handler(command);
  const persisted = repositories.messages.findByWhatsappId('pm-add-out-of-order');
  assert.equal(persisted.quoted_message_id, null);
  assert.equal(persisted.quoted_whatsapp_message_id, 'missing-bot-source');
  assert.equal(persisted.quoted_body, 'restart-safe evidence');
  assert.equal(persisted.quoted_sender_jid, BOT_JID);
  assert.equal(persisted.quoted_sent_at, 1_720_000_180_000);
  assert.deepEqual(JSON.parse(persisted.quoted_media_json), {
    type: 'document', mimeType: 'text/markdown', fileName: 'evidence.md',
    sizeBytes: 321, width: null, height: null, durationSeconds: null,
    pageCount: null, isViewOnce: false,
  });
  // A new repository object (the persistence boundary used after restart) sees
  // the complete snapshot without fetching the absent source from WhatsApp.
  const restartedRepositories = createRepositories(repositories.messages.db);
  assert.deepEqual(
    restartedRepositories.messages.findByWhatsappId('pm-add-out-of-order'),
    persisted
  );
});

test('dispatcher preserves direct and cross-group legacy behavior without PM side effects', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const client = new FakeClient();
  const adapter = new WhatsAppAdapter({ client });
  let routes = 0;
  const route = async (message) => {
    routes += 1;
    await message.reply('direct response');
  };
  const deduper = createMessageDeduper();
  const ingress = new AuthorizedGroupIngress({
    repositories, permissionService, route, isDuplicate: deduper,
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: route, isDuplicate: deduper,
    clock: () => 1_720_000_100_000,
  });

  const direct = await handler(rawMessage({ id: 'direct-legacy-id', from: USER_JID }));
  assert.equal(direct.source, 'legacy-direct');
  assert.equal(routes, 1);
  assert.equal(client.sends[0].chatJid, USER_JID);
  assert.equal(repositories.messages.findByWhatsappId('direct-legacy-id'), null);

  const otherGroup = await handler(rawMessage({
    id: 'cross-chat-id', from: OTHER_GROUP_JID, author: USER_JID,
    body: '!pm add',
  }));
  assert.equal(otherGroup.source, 'legacy-group');
  assert.equal(routes, 2, 'non-authorized groups must retain legacy routing');
  assert.equal(client.sends.length, 2);
  assert.equal(client.sends[1].chatJid, OTHER_GROUP_JID);
  assert.equal(repositories.messages.findByWhatsappId('cross-chat-id'), null,
    'cross-group legacy commands must have no PM persistence side effect');
});

test('durable route awaits smart-reply debounce, AI, and send before marking PROCESSED', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const client = new FakeClient();
  const adapter = new WhatsAppAdapter({ client });
  let announceStarted;
  let releaseAi;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const aiGate = new Promise((resolve) => { releaseAi = resolve; });
  const scheduler = createDebouncedSmartReplyScheduler({
    debounceMs: 1,
    process: async ({ message, body }) => {
      announceStarted();
      await aiGate;
      await message.reply(`AI: ${body}`);
    },
  });
  const route = (message, normalized, persisted) => scheduler.schedule({
    id: normalized.id,
    key: `${normalized.chatJid}\u0000${normalized.senderJid}`,
    message,
    body: normalized.body,
    userId: normalized.senderJid,
    persisted,
  });
  const ingress = new AuthorizedGroupIngress({ repositories, permissionService, route });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: route, clock: () => 1_720_000_300_000,
  });
  const raw = rawMessage({
    id: 'debounced-durable-route', from: GROUP_JID, author: USER_JID,
    body: 'wait for AI', timestamp: 1_720_000_290,
  });

  let routeSettled = false;
  const operation = handler(raw).then((result) => {
    routeSettled = true;
    return result;
  });
  await started;
  assert.equal(routeSettled, false);
  assert.equal(client.sends.length, 0);
  assert.equal(
    repositories.messages.findByWhatsappId(raw.id).processing_status,
    'PROCESSING'
  );

  releaseAi();
  const result = await operation;
  assert.equal(result.record.processing_status, 'PROCESSED');
  assert.equal(client.sends.length, 1);
  assert.equal(client.sends[0].content, 'AI: wait for AI');
  assert.deepEqual(await scheduler.drain(), {
    drained: true, timedOut: false, remaining: 0,
  });
});

test('smart-reply send failure rejects the route, records FAILED, and remains retryable', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const client = new FakeClient();
  const originalSend = client.sendMessage.bind(client);
  let sendAttempts = 0;
  client.sendMessage = async (...args) => {
    sendAttempts += 1;
    if (sendAttempts === 1) throw new Error('temporary send outage');
    return originalSend(...args);
  };
  const adapter = new WhatsAppAdapter({ client });
  const scheduler = createDebouncedSmartReplyScheduler({
    debounceMs: 0,
    process: async ({ message }) => message.reply('retryable AI reply'),
  });
  const route = (message, normalized, persisted) => scheduler.schedule({
    id: normalized.id,
    key: `${normalized.chatJid}\u0000${normalized.senderJid}`,
    message,
    body: normalized.body,
    userId: normalized.senderJid,
    persisted,
  });
  const deduper = createMessageDeduper();
  const ingress = new AuthorizedGroupIngress({
    repositories, permissionService, route, isDuplicate: deduper,
    clock: () => 1_720_000_400_000,
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: route, isDuplicate: deduper,
    clock: () => 1_720_000_400_000,
  });
  const raw = rawMessage({
    id: 'debounced-send-retry', from: GROUP_JID, author: USER_JID,
    body: 'please retry', timestamp: 1_720_000_390,
  });

  await assert.rejects(handler(raw), /temporary send outage/);
  let persisted = repositories.messages.findByWhatsappId(raw.id);
  assert.equal(persisted.processing_status, 'FAILED');
  assert.equal(persisted.processing_attempt_count, 1);
  assert.match(persisted.processing_last_error, /temporary send outage/);

  const retried = await handler(raw);
  persisted = repositories.messages.findByWhatsappId(raw.id);
  assert.equal(retried.duplicate, false);
  assert.equal(persisted.processing_status, 'PROCESSED');
  assert.equal(persisted.processing_attempt_count, 2);
  assert.equal(sendAttempts, 2);
  assert.equal(client.sends.length, 1);
});

test('stop-accepting and bounded drain wait for an in-flight route before shutdown', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const adapter = new WhatsAppAdapter({ client: new FakeClient() });
  let releaseRoute;
  let routeStarted;
  const started = new Promise((resolve) => { routeStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRoute = resolve; });
  const ingress = new AuthorizedGroupIngress({
    repositories,
    permissionService,
    route: async () => { routeStarted(); await gate; },
    clock: () => 1_720_000_300_000,
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: async () => {}, clock: () => 1_720_000_300_000,
  });
  const active = handler(rawMessage({
    id: 'shutdown-active-route', from: GROUP_JID, author: USER_JID,
    timestamp: 1_720_000_290,
  }));
  await started;
  assert.equal(handler.inFlightCount(), 1);
  assert.equal(handler.stopAccepting(), 1);
  assert.deepEqual(await handler(rawMessage({
    id: 'shutdown-rejected-route', from: GROUP_JID, author: USER_JID,
  })), { accepted: false, duplicate: false, source: 'stopping' });
  assert.equal(repositories.messages.findByWhatsappId('shutdown-rejected-route'), null);

  const timedOut = await handler.drain({ timeoutMs: 1 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.remaining, 1);
  const draining = handler.drain({ timeoutMs: 1000 });
  releaseRoute();
  assert.equal((await active).record.processing_status, 'PROCESSED');
  assert.deepEqual(await draining, { drained: true, timedOut: false, remaining: 0 });
  assert.equal(handler.inFlightCount(), 0);
});

test('legacy route failure is not retained by the memory deduper', async (t) => {
  const { repositories, permissionService } = fixture(t);
  const deduper = createMessageDeduper();
  let attempts = 0;
  const handler = createMessageEventHandler({
    ingress: new AuthorizedGroupIngress({
      repositories, permissionService, route: async () => {},
    }),
    adapter: new WhatsAppAdapter({ client: new FakeClient() }),
    isDuplicate: deduper,
    routeLegacy: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('legacy temporary failure');
    },
    clock: () => 1_720_000_400_000,
  });
  const direct = rawMessage({ id: 'legacy-retry', from: USER_JID, timestamp: 1_720_000_390 });
  await assert.rejects(handler(direct), /legacy temporary failure/);
  assert.equal((await handler(direct)).duplicate, false);
  assert.equal(attempts, 2);
});

test('fetched outgoing group media uses id.remote as authoritative chat, never from', async () => {
  const payload = Buffer.from('outgoing group evidence');
  const adapter = new WhatsAppAdapter({ client: new FakeClient() });
  const outgoing = {
    id: { _serialized: 'outgoing-media', remote: GROUP_JID },
    from: BOT_JID,
    _data: {},
    async downloadMedia() {
      return { data: payload.toString('base64'), mimetype: 'text/plain', filename: 'proof.txt' };
    },
  };
  const downloaded = await adapter.downloadAttachment(outgoing, {
    expectedMessageId: 'outgoing-media', expectedChatJid: GROUP_JID, maxBytes: 100,
  });
  assert.deepEqual(downloaded.buffer, payload);
  await assert.rejects(adapter.downloadAttachment({
    ...outgoing,
    id: { _serialized: 'wrong-chat-media', remote: OTHER_GROUP_JID },
    from: GROUP_JID,
  }, {
    expectedMessageId: 'wrong-chat-media', expectedChatJid: GROUP_JID, maxBytes: 100,
  }), (error) => error.code === 'MEDIA_SOURCE_MISMATCH');
});

test('authorized ingress stays paused through startup recovery and opens idempotently afterward', async (t) => {
  const { repositories, permissionService, chat } = fixture(t);
  const prior = repositories.messages.create({
    whatsappMessageId: 'prior-process-message', chatId: chat.id,
    senderJid: USER_JID, body: '!news', sentAt: 1_720_000_480_000,
    receivedAt: 1_720_000_480_001,
  }).record;
  repositories.messages.claimProcessing(prior.id, {
    claimId: 'dead-prior-message', now: 1_720_000_480_001, leaseMs: 999_999,
  });
  const reclaimed = repositories.messages.recoverProcessingForStartup(
    chat.id, 1_720_000_500_000
  );
  assert.deepEqual(reclaimed.map((row) => row.id), [prior.id]);
  assert.equal(repositories.messages.findById(prior.id).processing_status, 'FAILED');
  let routes = 0;
  const handler = createMessageEventHandler({
    ingress: new AuthorizedGroupIngress({
      repositories, permissionService, route: async () => { routes += 1; },
    }),
    adapter: new WhatsAppAdapter({ client: new FakeClient() }),
    routeLegacy: async () => { routes += 1; },
    clock: () => 1_720_000_500_000,
    authorizedInitiallyAccepting: false,
  });
  const authorized = rawMessage({
    id: 'paused-authorized', from: GROUP_JID, author: USER_JID, timestamp: 1_720_000_490,
  });
  assert.deepEqual(await handler(authorized), {
    accepted: false, duplicate: false, source: 'startup-recovery',
  });
  assert.equal(repositories.messages.findByWhatsappId('paused-authorized'), null);
  assert.equal(routes, 0);
  assert.equal(handler.startAuthorizedIngress(), true);
  assert.equal(handler.startAuthorizedIngress(), true, 'repeated ready/open is safe');
  assert.equal((await handler(authorized)).duplicate, false);
  assert.equal(routes, 1);
});

test('attachment queue saturation is contained inside ingress and message routing still completes', async (t) => {
  const { repositories, permissionService } = fixture(t);
  let routed = 0;
  const attachmentService = {
    captureIncoming() { throw new QueueFullError(1); },
    recordCaptureFailure(attachmentId, error) {
      return repositories.attachments.markCaptureFailed({
        attachmentId,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        now: 1_720_000_600_001,
      });
    },
  };
  const ingress = new AuthorizedGroupIngress({
    repositories,
    permissionService,
    attachmentService,
    logger: { warn() {}, error() {} },
    route: async () => { routed += 1; },
    clock: () => 1_720_000_600_000,
  });
  const handler = createMessageEventHandler({
    ingress,
    adapter: new WhatsAppAdapter({ client: new FakeClient() }),
    routeLegacy: async () => {},
    clock: () => 1_720_000_600_000,
  });
  const result = await handler(rawMessage({
    id: 'saturated-media', from: GROUP_JID, author: USER_JID,
    hasMedia: true, type: 'document', timestamp: 1_720_000_590,
    _data: { mimetype: 'text/plain', filename: 'busy.txt', size: 10 },
  }));
  assert.equal(result.record.processing_status, 'PROCESSED');
  assert.equal(routed, 1);
  const attachment = repositories.attachments.db.prepare(
    'SELECT * FROM attachments WHERE message_id = ?'
  ).get(result.record.id);
  assert.equal(attachment.processing_status, 'FAILED');
  assert.equal(attachment.last_error_code, 'QUEUE_FULL');
  assert.equal(attachment.retryable, 1);
});

test('disabled authorized chat rejects before persistence and route side effects', async (t) => {
  const { repositories, permissionService, chat } = fixture(t);
  repositories.chats.setEnabled(chat.id, false, 20);
  const adapter = new WhatsAppAdapter({ client: new FakeClient() });
  let routes = 0;
  const ingress = new AuthorizedGroupIngress({
    repositories, permissionService, route: async () => { routes += 1; },
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: async () => { routes += 1; },
    clock: () => 1_720_000_100_000,
  });
  await assert.rejects(handler(rawMessage({
    id: 'disabled-chat-id', from: GROUP_JID, author: USER_JID,
  })), (error) => error.code === 'CHAT_DISABLED');
  assert.equal(routes, 0);
  assert.equal(repositories.messages.findByWhatsappId('disabled-chat-id'), null);
});
