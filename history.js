'use strict';

// Compatibility adapter for the original in-memory history API. The configured,
// enabled PM group reads/writes the durable messages repository; direct chats and
// every other group continue to use the legacy bounded in-memory store.

const crypto = require('crypto');

function positiveEnvInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX = positiveEnvInteger('CONTEXT_MAX_MESSAGES', 200);
const MAX_CHATS = positiveEnvInteger('CONTEXT_MAX_CHATS', 200);
const DEFAULT_ASSISTANT_JID = 'wsb-history-assistant@c.us';

const store = new Map(); // chatId -> { msgs: [{role, name, text, ts}], last }
const persistentClearAfter = new Map();
let persistent = null;

function configure(options = {}) {
  if (!options.repositories?.chats
      || !options.repositories?.messages
      || typeof options.repositories.messages.listRecent !== 'function'
      || typeof options.repositories.messages.createProcessed !== 'function') {
    throw new TypeError('history.configure requires chat and message repositories');
  }
  const authorizedGroupJid = String(options.authorizedGroupJid || '').trim().toLowerCase();
  if (!authorizedGroupJid.endsWith('@g.us')) {
    throw new TypeError('history.configure requires an authorized group JID');
  }
  const clock = options.clock || Date.now;
  if (typeof clock !== 'function') throw new TypeError('history clock must be a function');
  persistent = {
    repositories: options.repositories,
    authorizedGroupJid,
    assistantJid: String(options.assistantJid || DEFAULT_ASSISTANT_JID),
    clock,
  };
  // An old in-memory entry must never shadow the newly configured durable chat.
  store.delete(authorizedGroupJid);
  return module.exports;
}

function resetConfiguration() {
  persistent = null;
  persistentClearAfter.clear();
}

function _get(chatId) {
  let entry = store.get(chatId);
  if (!entry) {
    entry = { msgs: [], last: Date.now() };
    store.set(chatId, entry);
  }
  return entry;
}

function _persistentChat(chatId) {
  if (!persistent || String(chatId || '').trim().toLowerCase() !== persistent.authorizedGroupJid) {
    return null;
  }
  const chat = persistent.repositories.chats.findByJid(persistent.authorizedGroupJid, {
    includeDeleted: true,
  });
  if (!chat || chat.enabled !== 1 || chat.deleted_at !== null) return null;
  return chat;
}

function _now() {
  const now = persistent.clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('history clock must return a non-negative safe integer');
  }
  return now;
}

function _pushMemory(chatId, role, text, name) {
  if (!chatId || !text || !text.trim()) return;
  const entry = _get(chatId);
  entry.msgs.push({ role, name: name || '', text: text.trim().slice(0, 1000), ts: Date.now() });
  if (entry.msgs.length > MAX) entry.msgs.splice(0, entry.msgs.length - MAX);
  entry.last = Date.now();
  if (store.size > MAX_CHATS) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [key, value] of store) {
      if (value.last < oldest) {
        oldest = value.last;
        oldestKey = key;
      }
    }
    if (oldestKey && oldestKey !== chatId) store.delete(oldestKey);
  }
}

function _pushPersistent(chat, role, text, name) {
  if (!text || !text.trim()) return;
  const now = _now();
  const id = crypto.randomUUID();
  persistent.repositories.messages.createProcessed({
    messageUid: `history-${id}`,
    whatsappMessageId: `history:${id}`,
    chatId: chat.id,
    senderJid: role === 'assistant'
      ? persistent.assistantJid
      : `history-user:${String(name || 'unknown').slice(0, 150)}`,
    messageType: role === 'assistant' ? 'SYSTEM' : 'TEXT',
    body: text.trim().slice(0, 1000),
    sentAt: now,
    receivedAt: now,
    isCommand: false,
  }, { completedAt: now });
}

function _push(chatId, role, text, name) {
  const chat = _persistentChat(chatId);
  if (chat) return _pushPersistent(chat, role, text, name);
  return _pushMemory(chatId, role, text, name);
}

function appendUser(chatId, name, text) {
  _push(chatId, 'user', text, name);
}

function appendAssistant(chatId, text) {
  _push(chatId, 'assistant', text);
}

// Existing return shape: [{ role, content }]. Commands are intentionally omitted
// from durable AI context; report queries can use the same repository option.
function getMessages(chatId) {
  const chat = _persistentChat(chatId);
  if (chat) {
    const rows = persistent.repositories.messages.listRecent(chat.id, {
      limit: MAX,
      after: persistentClearAfter.get(persistent.authorizedGroupJid) || 0,
      includeCommands: false,
      includeTombstones: false,
    });
    return rows.map((row) => {
      const text = String(row.body || '').trim().slice(0, 1000);
      if (row.message_type === 'SYSTEM') return { role: 'assistant', content: text };
      const sender = String(row.sender_jid || '');
      const name = sender.startsWith('history-user:')
        ? sender.slice('history-user:'.length)
        : sender.split('@')[0];
      return {
        role: 'user',
        content: name ? `${name}: ${text}` : text,
      };
    }).filter((message) => message.content);
  }

  const entry = store.get(chatId);
  if (!entry) return [];
  return entry.msgs.map((message) => ({
    role: message.role,
    content: message.role === 'user' && message.name
      ? `${message.name}: ${message.text}`
      : message.text,
  }));
}

function clear(chatId) {
  const chat = _persistentChat(chatId);
  if (chat) {
    // Do not delete durable report/audit sources. Preserve the old process-local
    // "start a fresh context" behavior by moving this adapter's read boundary.
    persistentClearAfter.set(persistent.authorizedGroupJid, _now() + 1);
    return;
  }
  store.delete(chatId);
}

module.exports = {
  MAX,
  appendAssistant,
  appendUser,
  clear,
  configure,
  getMessages,
  resetConfiguration,
};
