'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeChatJid, serializedId, utcTimestampMs } = require('./normalize-message');

function defaultMediaFactory(filePath) {
  const { MessageMedia } = require('whatsapp-web.js');
  return MessageMedia.fromFilePath(filePath);
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
   * Preserve the legacy Message interface while routing replies through this
   * adapter, allowing the existing command/smart-reply code to stay unchanged.
   */
  wrapIncoming(message, normalized) {
    const adapter = this;
    return new Proxy(message, {
      get(target, property, receiver) {
        if (property === 'reply') {
          return async (content, chatId, options = {}) => {
            const targetJid = chatId || normalized.chatJid;
            return adapter.sendText(targetJid, content, {
              quotedMessageId: options.quotedMessageId || normalized.id,
              sendOptions: options,
            });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }
}

module.exports = { WhatsAppAdapter, sentReceipt };
