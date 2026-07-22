'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseNamespacedCommand, tokenizeArguments } = require('../commands/parser');
const { createCommandRouter } = require('../commands/router');
const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const history = require('../history');
const { createMessageDeduper } = require('../message-deduper');
const { PermissionService } = require('../services/permission-service');
const { WhatsAppAdapter } = require('../whatsapp/adapter');
const { AuthorizedGroupIngress, createMessageEventHandler } = require('../whatsapp/ingress');

const GROUP_JID = '120300000000000000@g.us';
const OTHER_GROUP_JID = '120300000000000001@g.us';
const USER_JID = '60111111111@c.us';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-command-test-'));
  const filename = path.join(root, 'db.sqlite3');
  let db = getDatabase({ filename, busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  let repositories = createRepositories(db);
  const chat = repositories.chats.create({
    chatUid: 'authorized-command-chat', jid: GROUP_JID,
    timezone: 'Asia/Kuala_Lumpur', now: 10,
  }).record;
  const permissionService = new PermissionService({ repositories, authorizedChatJid: GROUP_JID });
  t.after(() => {
    history.resetConfiguration();
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    filename,
    chat,
    get db() { return db; },
    get repositories() { return repositories; },
    permissionService,
    restart() {
      closeDatabase(db);
      db = getDatabase({ filename, busyTimeoutMs: 1000, fileMustExist: true });
      repositories = createRepositories(db);
      return repositories;
    },
  };
}

function normalized(overrides = {}) {
  return {
    id: overrides.id || 'command-id',
    chatJid: overrides.chatJid || GROUP_JID,
    senderJid: overrides.senderJid || USER_JID,
    isGroup: overrides.isGroup ?? true,
    fromMe: false,
    body: overrides.body ?? '!pm help',
    type: 'TEXT',
    sentAt: overrides.sentAt ?? 1000,
    receivedAt: overrides.receivedAt ?? 1001,
    isCommand: true,
    quoted: null,
    media: null,
  };
}

function rawMessage(overrides = {}) {
  const from = overrides.from || GROUP_JID;
  return {
    id: { _serialized: overrides.id || 'raw-command-id' },
    from,
    to: '60999999999@c.us',
    author: overrides.author || (from.endsWith('@g.us') ? USER_JID : undefined),
    fromMe: false,
    timestamp: overrides.timestamp ?? 2,
    body: overrides.body ?? '!pm help',
    hasMedia: false,
    type: 'chat',
    _data: {},
    ...overrides,
  };
}

class FakeClient {
  constructor() { this.sends = []; }
  async sendMessage(chatJid, content, options) {
    this.sends.push({ chatJid, content, options });
    return { id: { _serialized: `sent-${this.sends.length}` }, timestamp: 3 };
  }
}

test('parser handles quoting, escaping, Chinese, Unicode whitespace, and preserves empty arguments', () => {
  const parsed = parseNamespacedCommand(
    '  !PM\tupdate　TV8  description="中文 空格" note=单\\ 字 \'\' "a\\"b"'
  );
  assert.equal(parsed.matched, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.namespace, 'pm');
  assert.equal(parsed.command, 'update');
  assert.deepEqual(parsed.args, [
    'TV8', 'description=中文 空格', 'note=单 字', '', 'a"b',
  ]);

  const summary = parseNamespacedCommand('!SUMMARY since "2026-07-20 09:00" 中文');
  assert.equal(summary.namespace, 'summary');
  assert.equal(summary.command, null);
  assert.deepEqual(summary.args, ['since', '2026-07-20 09:00', '中文']);
  assert.equal(parseNamespacedCommand('!pmx add').matched, false);
  assert.equal(parseNamespacedCommand('普通中文消息').matched, false);
});

test('parser returns bounded, explicit errors for malformed and malicious input', () => {
  assert.equal(parseNamespacedCommand('!pm update "oops').error.code, 'UNCLOSED_QUOTE');
  assert.equal(parseNamespacedCommand('!pm update value\\').error.code, 'TRAILING_ESCAPE');
  assert.equal(parseNamespacedCommand('!pm ' + 'x'.repeat(21), {
    maxInputLength: 20,
  }).error.code, 'COMMAND_TOO_LONG');
  assert.equal(parseNamespacedCommand('!pm ' + 'x'.repeat(11), {
    maxInputLength: 100, maxArgumentLength: 10,
  }).error.code, 'ARGUMENT_TOO_LONG');
  assert.equal(tokenizeArguments('a b c', {
    maxArguments: 2,
  }).error.code, 'TOO_MANY_ARGUMENTS');
});

test('router handles help/missing/unknown, supports injectable handlers, and awaits replies', async (t) => {
  const { permissionService } = fixture(t);
  const replies = [];
  const message = { body: '', reply: async (text) => { replies.push(text); } };
  const calls = [];
  const router = createCommandRouter({
    permissionService,
    pmHandlers: {
      show: async (context) => {
        calls.push({ type: 'pm', args: context.parsed.args, persisted: context.persisted });
        return 'pm-value';
      },
    },
    summaryHandler: async (context) => {
      calls.push({ type: 'summary', args: context.parsed.args });
      return 'summary-value';
    },
  });

  let result = await router.route(message, normalized({ body: '!pm' }));
  assert.equal(result.kind, 'missing');
  assert.match(replies.pop(), /缺少 PM 子命令/);
  result = await router.route(message, normalized({ body: '!pm help' }));
  assert.equal(result.kind, 'help');
  assert.match(replies.pop(), /PM 命令帮助/);
  result = await router.route(message, normalized({ body: '!pm 不存在' }));
  assert.equal(result.kind, 'unknown');
  assert.match(replies.pop(), /不存在/);
  result = await router.route(message, normalized({ body: '!summary help' }));
  assert.equal(result.kind, 'help');
  assert.match(replies.pop(), /群聊摘要命令帮助/);

  const persisted = { id: 99 };
  result = await router.route(message, normalized({ body: '!pm show TV9' }), persisted);
  assert.equal(result.kind, 'handler');
  assert.equal(result.value, 'pm-value');
  result = await router.route(message, normalized({ body: '!summary since "2026-07-20 09:00"' }));
  assert.equal(result.value, 'summary-value');
  assert.deepEqual(calls, [
    { type: 'pm', args: ['TV9'], persisted },
    { type: 'summary', args: ['since', '2026-07-20 09:00'] },
  ]);
});

test('router refuses PM/summary outside the configured enabled group before reply/handler', async (t) => {
  const context = fixture(t);
  let sideEffects = 0;
  const router = createCommandRouter({
    permissionService: context.permissionService,
    pmHandlers: { show: async () => { sideEffects += 1; } },
  });
  const message = { reply: async () => { sideEffects += 1; } };
  await assert.rejects(
    router.route(message, normalized({ chatJid: OTHER_GROUP_JID, body: '!pm show TV1' })),
    (error) => error.code === 'CHAT_NOT_AUTHORIZED'
  );
  assert.equal(sideEffects, 0);

  context.repositories.chats.setEnabled(context.chat.id, false, 20);
  await assert.rejects(
    router.route(message, normalized({ body: '!summary help' })),
    (error) => error.code === 'CHAT_DISABLED'
  );
  assert.equal(sideEffects, 0);
});

test('authorized history is durable across repository restart while commands are excluded', (t) => {
  const context = fixture(t);
  let now = 2000;
  context.repositories.messages.create({
    messageUid: 'durable-user', whatsappMessageId: 'wa-durable-user',
    chatId: context.chat.id, senderJid: USER_JID, body: '重启后还在',
    sentAt: 1900, receivedAt: 1901, isCommand: false,
  });
  context.repositories.messages.create({
    messageUid: 'durable-command', whatsappMessageId: 'wa-durable-command',
    chatId: context.chat.id, senderJid: USER_JID, body: '!pm show TV1',
    sentAt: 1950, receivedAt: 1951, isCommand: true,
  });
  history.configure({
    repositories: context.repositories, authorizedGroupJid: GROUP_JID, clock: () => now,
  });
  history.appendUser(GROUP_JID, '小明', '兼容 API 写入');
  history.appendAssistant(GROUP_JID, '持久化助手回复');
  assert.deepEqual(history.getMessages(GROUP_JID), [
    { role: 'user', content: '60111111111: 重启后还在' },
    { role: 'user', content: '小明: 兼容 API 写入' },
    { role: 'assistant', content: '持久化助手回复' },
  ]);

  const restartedRepositories = context.restart();
  now = 3000;
  history.resetConfiguration();
  history.configure({
    repositories: restartedRepositories, authorizedGroupJid: GROUP_JID, clock: () => now,
  });
  assert.deepEqual(history.getMessages(GROUP_JID), [
    { role: 'user', content: '60111111111: 重启后还在' },
    { role: 'user', content: '小明: 兼容 API 写入' },
    { role: 'assistant', content: '持久化助手回复' },
  ]);
  const storedAssistant = restartedRepositories.messages.db.prepare(
    "SELECT * FROM messages WHERE whatsapp_message_id LIKE 'history:%' AND message_type='SYSTEM'"
  ).get();
  assert.equal(storedAssistant.processing_status, 'PROCESSED');
  assert.equal(storedAssistant.is_command, 0);
});

test('direct and non-authorized history retains the legacy in-memory API and return shape', (t) => {
  fixture(t);
  history.resetConfiguration();
  history.clear('direct@c.us');
  history.appendUser('direct@c.us', '小明', ' 你好 ');
  history.appendAssistant('direct@c.us', '欢迎');
  assert.deepEqual(history.getMessages('direct@c.us'), [
    { role: 'user', content: '小明: 你好' },
    { role: 'assistant', content: '欢迎' },
  ]);
  history.clear('direct@c.us');
  assert.deepEqual(history.getMessages('direct@c.us'), []);
});

test('report source window can exclude persisted command noise', (t) => {
  const context = fixture(t);
  for (const [id, body, isCommand, sentAt] of [
    ['source-one', '讨论内容', false, 100],
    ['source-command', '!pm help', true, 110],
    ['source-two', '决定事项', false, 120],
  ]) {
    context.repositories.messages.create({
      messageUid: id, whatsappMessageId: id, chatId: context.chat.id,
      senderJid: USER_JID, body, sentAt, receivedAt: sentAt, isCommand,
    });
  }
  assert.deepEqual(
    context.repositories.messages.listWindow(context.chat.id, 90, 130, {
      includeCommands: false,
    }).map((row) => row.body),
    ['讨论内容', '决定事项']
  );
  assert.equal(
    context.repositories.messages.listWindow(context.chat.id, 90, 130).length,
    3
  );
});

test('namespaced router has priority, delegates non-namespaced legacy unchanged, and success follows route', async (t) => {
  const context = fixture(t);
  const client = new FakeClient();
  const adapter = new WhatsAppAdapter({ client });
  const router = createCommandRouter({ permissionService: context.permissionService });
  let legacyCalls = 0;
  const legacy = async () => { legacyCalls += 1; };
  const route = async (message, normalizedMessage, persisted) => {
    const result = await router.route(message, normalizedMessage, persisted);
    if (result.handled) return result;
    return legacy(message, normalizedMessage, persisted);
  };
  const deduper = createMessageDeduper();
  const ingress = new AuthorizedGroupIngress({
    repositories: context.repositories,
    permissionService: context.permissionService,
    route,
    isDuplicate: deduper,
    clock: () => 3000,
  });
  const handler = createMessageEventHandler({
    ingress, adapter, routeLegacy: legacy, isDuplicate: deduper, clock: () => 3000,
  });

  await handler(rawMessage({ id: 'priority-pm', body: '!pm what' }));
  assert.equal(legacyCalls, 0);
  assert.match(client.sends[0].content, /未知或尚未启用/);
  const persistedCommand = context.repositories.messages.findByWhatsappId('priority-pm');
  assert.equal(persistedCommand.processing_status, 'PROCESSED');
  assert.equal(persistedCommand.is_command, 1);

  await handler(rawMessage({ id: 'legacy-news', body: '!news' }));
  assert.equal(legacyCalls, 1);

  await handler(rawMessage({
    id: 'direct-pm-remains-legacy', from: USER_JID, author: undefined, body: '!pm what',
  }));
  assert.equal(legacyCalls, 2, 'direct PM-looking text must retain the legacy path');
  assert.equal(context.repositories.messages.findByWhatsappId('direct-pm-remains-legacy'), null);
});

test('durable ingress marks command processed only after the awaited router handler completes', async (t) => {
  const context = fixture(t);
  const adapter = new WhatsAppAdapter({ client: new FakeClient() });
  let release;
  let started;
  const handlerStarted = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const router = createCommandRouter({
    permissionService: context.permissionService,
    pmHandlers: {
      injected: async () => { started(); await gate; },
    },
  });
  const ingress = new AuthorizedGroupIngress({
    repositories: context.repositories,
    permissionService: context.permissionService,
    route: (message, event, persisted) => router.route(message, event, persisted),
    clock: () => 3000,
  });
  const dispatch = createMessageEventHandler({
    ingress, adapter, routeLegacy: async () => {}, clock: () => 3000,
  });

  const pending = dispatch(rawMessage({ id: 'await-router', body: '!pm injected' }));
  await handlerStarted;
  assert.equal(
    context.repositories.messages.findByWhatsappId('await-router').processing_status,
    'PROCESSING'
  );
  release();
  await pending;
  assert.equal(
    context.repositories.messages.findByWhatsappId('await-router').processing_status,
    'PROCESSED'
  );
});
