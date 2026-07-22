'use strict';

const config = require('../config');

class MessageNormalizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessageNormalizationError';
    this.code = code;
  }
}

function serializedId(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value._serialized === 'string') return value._serialized.trim();
  if (value.id && value.id !== value) return serializedId(value.id);
  return '';
}

function jidValue(value) {
  return serializedId(value) || (typeof value === 'string' ? value.trim() : '');
}

function normalizeChatJid(value, normalizeJid = config.normalizeJid) {
  const raw = jidValue(value);
  if (!raw) return '';
  return raw.toLowerCase().endsWith('@g.us')
    ? normalizeJid(raw, { kind: 'group' })
    : normalizeJid(raw, { kind: 'user' });
}

function normalizeUserJid(value, normalizeJid = config.normalizeJid) {
  return normalizeJid(jidValue(value), { kind: 'user' });
}

function utcTimestampMs(value, name = 'timestamp') {
  const numeric = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new MessageNormalizationError('INVALID_TIMESTAMP', `${name} must be a valid Unix timestamp`);
  }
  // whatsapp-web.js exposes Message.timestamp in Unix seconds. Accept milliseconds
  // as well so fixtures and future client versions do not get multiplied twice.
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  if (!Number.isSafeInteger(Math.trunc(milliseconds))) {
    throw new MessageNormalizationError('INVALID_TIMESTAMP', `${name} is outside the safe timestamp range`);
  }
  return Math.trunc(milliseconds);
}

function finiteMetadataInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
}

function mediaMetadata(source) {
  if (!source) return null;
  const data = source._data || source;
  const hasMedia = source.hasMedia === true || Boolean(data.directPath)
    || Boolean(data.mimetype || data.mimeType);
  if (!hasMedia) return null;

  return Object.freeze({
    type: String(source.type || data.type || 'media'),
    mimeType: String(data.mimetype || data.mimeType || '').trim() || null,
    fileName: String(data.filename || data.fileName || '').trim() || null,
    sizeBytes: finiteMetadataInteger(data.size || data.filesize || data.fileSize),
    width: finiteMetadataInteger(data.width),
    height: finiteMetadataInteger(data.height),
    durationSeconds: finiteMetadataInteger(source.duration ?? data.duration),
    pageCount: finiteMetadataInteger(data.pageCount || data.page_count),
    isViewOnce: Boolean(data.isViewOnce),
  });
}

function normalizedQuote(message, chatJid, normalizeJid) {
  const data = message._data || {};
  const quoted = data.quotedMsg || message.quotedMessage || null;
  const quoteId = serializedId(quoted?.id)
    || serializedId(data.quotedMessageId)
    || serializedId(data.quotedStanzaID);
  if (!quoted && !message.hasQuotedMsg && !quoteId) return null;

  const quotedChatJid = normalizeChatJid(
    quoted?.from || quoted?.id?.remote || data.quotedRemoteJid || chatJid,
    normalizeJid
  ) || chatJid;
  const senderJid = normalizeUserJid(
    quoted?.author || quoted?.id?.participant || data.quotedParticipant,
    normalizeJid
  ) || null;
  let sentAt = null;
  const rawTimestamp = quoted?.timestamp ?? quoted?.t;
  if (rawTimestamp !== undefined && rawTimestamp !== null) {
    try { sentAt = utcTimestampMs(rawTimestamp, 'quoted timestamp'); } catch { sentAt = null; }
  }

  return Object.freeze({
    id: quoteId || null,
    chatJid: quotedChatJid,
    senderJid,
    body: String(quoted?.body || quoted?.caption || ''),
    sentAt,
    media: mediaMetadata(quoted),
  });
}

/**
 * Convert a whatsapp-web.js Message into a side-effect-free transport record.
 * This function only reads already-present metadata. It never calls
 * getQuotedMessage(), getContact(), getChat(), or downloadMedia().
 */
function normalizeMessage(message, options = {}) {
  if (!message || typeof message !== 'object') {
    throw new MessageNormalizationError('INVALID_MESSAGE', 'A WhatsApp message object is required');
  }
  const normalizeJid = options.normalizeJid || config.normalizeJid;
  const id = serializedId(message.id || message._data?.id);
  if (!id) {
    throw new MessageNormalizationError('MISSING_MESSAGE_ID', 'A serialized WhatsApp message ID is required');
  }

  const rawChatJid = message.fromMe ? message.to : message.from;
  const chatJid = normalizeChatJid(rawChatJid || message._data?.id?.remote, normalizeJid);
  if (!chatJid) {
    throw new MessageNormalizationError('INVALID_CHAT_JID', 'A valid chat JID is required');
  }
  const isGroup = chatJid.endsWith('@g.us');
  const senderCandidate = message.author
    || message._data?.author
    || message._data?.id?.participant
    || (!message.fromMe && !isGroup ? message.from : null);
  const senderJid = normalizeUserJid(senderCandidate, normalizeJid);
  if (!senderJid) {
    throw new MessageNormalizationError('INVALID_SENDER_JID', 'A valid sender @c.us or @lid JID is required');
  }

  const sentAt = utcTimestampMs(message.timestamp ?? message._data?.t, 'message timestamp');
  const receivedClock = options.receivedAt === undefined
    ? (options.clock || Date.now)()
    : options.receivedAt;
  const receivedAt = Math.max(sentAt, utcTimestampMs(receivedClock, 'received timestamp'));
  const body = String(message.body ?? message._data?.caption ?? message._data?.body ?? '');
  const media = mediaMetadata(message);

  return Object.freeze({
    id,
    chatJid,
    senderJid,
    isGroup,
    fromMe: Boolean(message.fromMe),
    body,
    type: media ? 'MEDIA' : 'TEXT',
    sentAt,
    receivedAt,
    isCommand: body.trimStart().startsWith('!'),
    quoted: normalizedQuote(message, chatJid, normalizeJid),
    media,
  });
}

module.exports = {
  MessageNormalizationError,
  mediaMetadata,
  normalizeChatJid,
  normalizeMessage,
  normalizeUserJid,
  serializedId,
  utcTimestampMs,
};
