'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeChatJid, serializedId, utcTimestampMs } = require('./normalize-message');

function defaultMediaFactory(filePath) {
  const { MessageMedia } = require('whatsapp-web.js');
  return MessageMedia.fromFilePath(filePath);
}

class MediaDownloadError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'MediaDownloadError';
    this.code = code;
    this.retryable = options.retryable !== false;
  }
}

function decodeMediaPayload(media, maxBytes) {
  if (!media || typeof media.data !== 'string' || media.data.length === 0) {
    throw new MediaDownloadError('MEDIA_EXPIRED', 'WhatsApp media is unavailable or expired');
  }
  if (Number.isSafeInteger(maxBytes)) {
    const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
    // Standard WhatsApp payloads contain no whitespace. Permit a small amount
    // for compatibility, but reject before replace() can allocate a huge copy.
    if (media.data.length > maxEncodedLength + 1024) {
      throw new MediaDownloadError('FILE_TOO_LARGE', `Encoded media exceeds ${maxBytes} bytes`, {
        retryable: false,
      });
    }
  }
  const compact = media.data.replace(/\s+/gu, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)) {
    throw new MediaDownloadError('DOWNLOAD_INVALID_BASE64', 'WhatsApp returned invalid media data', {
      retryable: false,
    });
  }
  const estimatedBytes = Math.floor(compact.length * 3 / 4)
    - (compact.endsWith('==') ? 2 : (compact.endsWith('=') ? 1 : 0));
  if (Number.isSafeInteger(maxBytes) && estimatedBytes > maxBytes) {
    throw new MediaDownloadError('FILE_TOO_LARGE', `Media exceeds ${maxBytes} bytes`, {
      retryable: false,
    });
  }
  const buffer = Buffer.from(compact, 'base64');
  if (Number.isSafeInteger(maxBytes) && buffer.length > maxBytes) {
    throw new MediaDownloadError('FILE_TOO_LARGE', `Media exceeds ${maxBytes} bytes`, {
      retryable: false,
    });
  }
  return buffer;
}

function sentReceipt(result) {
  if (!result) return { id: null, sentAt: null, raw: result };
  let sentAt = null;
  const timestamp = result.timestamp ?? result._data?.t;
  if (timestamp !== undefined && timestamp !== null) {
    try { sentAt = utcTimestampMs(timestamp, 'sent timestamp'); } catch { sentAt = null; }
  }
  return { id: serializedId(result.id || result._data?.id) || null, sentAt, raw: result };
}

class WhatsAppAdapter {
  constructor(options = {}) {
    if (!options.client || typeof options.client.sendMessage !== 'function') {
      throw new TypeError('WhatsAppAdapter requires a client with sendMessage()');
    }
    this.client = options.client;
    this.mediaFactory = options.mediaFactory || defaultMediaFactory;
    this.fileExists = options.fileExists || fs.existsSync;
  }

  async sendText(chatJid, text, options = {}) {
    const target = normalizeChatJid(chatJid);
    if (!target) throw new TypeError('sendText requires a valid chat JID');
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('sendText requires non-empty text');
    }
    const sendOptions = { ...(options.sendOptions || {}) };
    if (options.quotedMessageId) sendOptions.quotedMessageId = String(options.quotedMessageId);
    const result = await this.client.sendMessage(target, text, sendOptions);
    return sentReceipt(result);
  }

  async sendParts(chatJid, parts, options = {}) {
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new TypeError('sendParts requires at least one message part');
    }
    const receipts = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (typeof part !== 'string' || part.length === 0) {
        throw new TypeError(`Message part ${index} must be non-empty text`);
      }
      const sendOptions = typeof options.sendOptionsForPart === 'function'
        ? options.sendOptionsForPart(index, parts.length)
        : options.sendOptions;
      receipts.push(await this.sendText(chatJid, part, {
        quotedMessageId: index === 0 ? options.quotedMessageId : null,
        sendOptions,
      }));
    }
    return receipts;
  }

  _assertDownloadedIdentity(message, options = {}) {
    if (!options.expectedMessageId && !options.expectedChatJid) return;
    const actualId = serializedId(message?.id || message?._data?.id);
    // For fetched outgoing group messages, `from` is the sender account while
    // the authoritative conversation is always the message key's id.remote.
    const remote = message?.id?.remote || message?._data?.id?.remote || message?.from;
    const actualChat = normalizeChatJid(remote);
    if (options.expectedMessageId && actualId !== String(options.expectedMessageId)) {
      throw new MediaDownloadError(
        'MEDIA_SOURCE_MISMATCH',
        'Fetched WhatsApp message ID does not match the authorized attachment source',
        { retryable: false }
      );
    }
    if (options.expectedChatJid && actualChat !== normalizeChatJid(options.expectedChatJid)) {
      throw new MediaDownloadError(
        'MEDIA_SOURCE_MISMATCH',
        'Fetched WhatsApp message belongs to a different chat',
        { retryable: false }
      );
    }
  }

  async downloadAttachment(message, options = {}) {
    if (!message || typeof message.downloadMedia !== 'function') {
      throw new MediaDownloadError('MEDIA_UNAVAILABLE', 'WhatsApp message cannot download media');
    }
    this._assertDownloadedIdentity(message, options);
    if (options.signal?.aborted) {
      throw new MediaDownloadError('DOWNLOAD_ABORTED', 'WhatsApp media download was aborted');
    }
    const declaredSize = Number(message._data?.size ?? message._data?.filesize
      ?? message._data?.fileSize ?? options.sizeBytes);
    if (Number.isSafeInteger(options.maxBytes) && Number.isFinite(declaredSize)
        && declaredSize > options.maxBytes) {
      throw new MediaDownloadError('FILE_TOO_LARGE', `Media exceeds ${options.maxBytes} bytes`, {
        retryable: false,
      });
    }
    let media;
    try {
      media = await message.downloadMedia();
    } catch (error) {
      const expired = /expired|not found|gone|unavailable|media.*missing/iu.test(String(error?.message || ''));
      throw new MediaDownloadError(
        expired ? 'MEDIA_EXPIRED' : 'DOWNLOAD_FAILED',
        expired ? 'WhatsApp media is expired' : 'WhatsApp media download failed',
        { cause: error }
      );
    }
    if (options.signal?.aborted) {
      throw new MediaDownloadError('DOWNLOAD_ABORTED', 'WhatsApp media download was aborted');
    }
    const buffer = decodeMediaPayload(media, options.maxBytes);
    return Object.freeze({
      buffer,
      mimeType: String(media.mimetype || message._data?.mimetype || options.mimeType || '').trim() || null,
      fileName: String(media.filename || message._data?.filename || options.fileName || '').trim() || null,
      sizeBytes: buffer.length,
    });
  }

  async downloadQuotedAttachment(message, options = {}) {
    if (!message || typeof message.getQuotedMessage !== 'function') {
      throw new MediaDownloadError('QUOTED_MEDIA_UNAVAILABLE', 'Quoted WhatsApp message is unavailable');
    }
    let quoted;
    try {
      quoted = await message.getQuotedMessage();
    } catch (error) {
      throw new MediaDownloadError('MEDIA_EXPIRED', 'Quoted WhatsApp media is expired or unavailable', {
        cause: error,
      });
    }
    if (!quoted || quoted.hasMedia !== true) {
      throw new MediaDownloadError('QUOTED_MEDIA_UNAVAILABLE', 'Quoted message has no downloadable attachment', {
        retryable: false,
      });
    }
    this._assertDownloadedIdentity(quoted, options);
    return this.downloadAttachment(quoted, options);
  }

  async downloadAttachmentByMessageId(whatsappMessageId, options = {}) {
    if (typeof this.client.getMessageById !== 'function') {
      throw new MediaDownloadError('MEDIA_LOOKUP_UNAVAILABLE', 'WhatsApp client cannot look up source media');
    }
    let message;
    try {
      message = await this.client.getMessageById(String(whatsappMessageId || ''));
    } catch (error) {
      throw new MediaDownloadError('DOWNLOAD_FAILED', 'WhatsApp source media lookup failed', {
        cause: error,
      });
    }
    if (!message) {
      throw new MediaDownloadError('MEDIA_EXPIRED', 'WhatsApp source media is expired or unavailable');
    }
    this._assertDownloadedIdentity(message, {
      ...options,
      expectedMessageId: options.expectedMessageId || whatsappMessageId,
    });
    return this.downloadAttachment(message, options);
  }

  async sendArchivedAttachment(chatJid, attachment, options = {}) {
    const target = normalizeChatJid(chatJid);
    if (!target) throw new TypeError('sendArchivedAttachment requires a valid chat JID');
    if (!attachment || typeof attachment !== 'object') {
      throw new TypeError('An archived attachment descriptor is required');
    }
    const filePath = path.resolve(String(attachment.path || attachment.filePath || ''));
    if (!attachment.path && !attachment.filePath) throw new TypeError('Archived attachment path is required');
    if (!this.fileExists(filePath)) throw new Error(`Archived attachment not found: ${filePath}`);

    const media = await this.mediaFactory(filePath, attachment);
    if (!media) throw new Error('Media factory did not return attachment content');
    if (attachment.displayName) media.filename = String(attachment.displayName);
    const sendOptions = {
      sendMediaAsDocument: options.sendMediaAsDocument !== false,
      ...(options.sendOptions || {}),
    };
    if (options.caption) sendOptions.caption = String(options.caption);
    if (options.quotedMessageId) sendOptions.quotedMessageId = String(options.quotedMessageId);
    const result = await this.client.sendMessage(target, media, sendOptions);
    return sentReceipt(result);
  }

  /**
   * Preserve whatsapp-web.js Message.reply() semantics for legacy handlers.
   * Text remains routed through the injectable client and returns its real
   * Message result. Rich content is delegated to the original method because
   * whatsapp-web.js owns its MessageMedia/Location compatibility behavior.
   */
  wrapIncoming(message, normalized) {
    const adapter = this;
    const originalReply = typeof message.reply === 'function' ? message.reply.bind(message) : null;
    return new Proxy(message, {
      get(target, property, receiver) {
        if (property === 'reply') {
          return async (content, chatId, options = {}) => {
            if (typeof content !== 'string' && originalReply) {
              return originalReply(content, chatId, options);
            }

            const targetJid = chatId || normalized.chatJid;
            if (!targetJid) throw new TypeError('reply requires a target chat JID');
            // Message.reply() always quotes the receiving message, overriding any
            // caller-provided quotedMessageId, and returns client.sendMessage().
            return adapter.client.sendMessage(targetJid, content, {
              ...options,
              quotedMessageId: normalized.id,
            });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }
}

module.exports = {
  MediaDownloadError,
  WhatsAppAdapter,
  decodeMediaPayload,
  sentReceipt,
};
