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
const { PermissionService } = require('../services/permission-service');
const { WhatsAppAdapter } = require('../whatsapp/adapter');
const { AuthorizedGroupIngress, createMessageEventHandler } = require('../whatsapp/ingress');
const { normalizeMessage } = require('../whatsapp/normalize-message');

const GROUP_JID = '120300000000000000@g.us';
const OTHER_GROUP_JID = '120300000000000001@g.us';
const USER_JID = '60111111111@c.us';
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
      mimetype: 'application/pdf', filename: 'evidence.pdf', size: 12345,
      pageCount: 3, quotedMsg: quotedData,
    },
  }), { receivedAt: 1_720_000_001_250 });

  assert.equal(group.chatJid, GROUP_JID);
  assert.equal(group.senderJid, LID_JID);
  assert.equal(group.isCommand, true);
  assert.equal(group.type, 'MEDIA');
  assert.deepEqual(group.media, {
    type: 'document', mimeType: 'application/pdf', fileName: 'evidence.pdf',
    sizeBytes: 12345, width: null, height: null, durationSeconds: null,
    pageCount: 3, isViewOnce: false,
  });
  assert.deepEqual(group.quoted, {
    id: 'quoted-id', chatJid: GROUP_JID, senderJid: USER_JID,
    body: 'quoted evidence', sentAt: 1_719_999_900_000, media: null,
  });
  assert.equal(downloads, 0, 'normalization must not download media');
  assert.equal(quoteFetches, 0, 'normalization must not fetch quoted content');
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
  assert.equal(persisted.quoted_message_id, quoted.id);
  assert.equal(persisted.quoted_whatsapp_message_id, quoted.whatsapp_message_id);
  assert.equal(persisted.message_type, 'MEDIA');
  const attachment = repositories.attachments.db.prepare(
    'SELECT * FROM attachments WHERE message_id = ?'
  ).get(persisted.id);
  assert.equal(attachment.display_name, 'notes.md');
  assert.equal(attachment.detected_mime, 'text/markdown');
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

test('dispatcher preserves direct legacy behavior but rejects cross-chat groups before persistence or routing', async (t) => {
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

  await assert.rejects(handler(rawMessage({
    id: 'cross-chat-id', from: OTHER_GROUP_JID, author: USER_JID,
  })), (error) => error.code === 'CHAT_NOT_AUTHORIZED');
  assert.equal(routes, 1, 'unauthorized group must never reach legacy behavior');
  assert.equal(client.sends.length, 1);
  assert.equal(repositories.messages.findByWhatsappId('cross-chat-id'), null);
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
