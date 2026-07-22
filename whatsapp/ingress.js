'use strict';

const { normalizeMessage } = require('./normalize-message');

class AuthorizedGroupIngress {
  constructor(options = {}) {
    if (!options.repositories?.messages || !options.repositories?.attachments) {
      throw new TypeError('AuthorizedGroupIngress requires message and attachment repositories');
    }
    if (!options.permissionService || typeof options.permissionService.assertAuthorizedChat !== 'function') {
      throw new TypeError('AuthorizedGroupIngress requires PermissionService');
    }
    if (typeof options.route !== 'function') {
      throw new TypeError('AuthorizedGroupIngress requires a route callback');
    }
    this.repositories = options.repositories;
    this.permissionService = options.permissionService;
    this.route = options.route;
    this.isDuplicate = options.isDuplicate || (() => false);
    this.logger = options.logger || console;
  }

  persist(normalized, chat) {
    return this.repositories.transaction(() => {
      let quotedMessageId = null;
      if (normalized.quoted?.id) {
        const quoted = this.repositories.messages.findByWhatsappId(normalized.quoted.id);
        if (quoted?.chat_id === chat.id) quotedMessageId = quoted.id;
      }

      const messageResult = this.repositories.messages.create({
        whatsappMessageId: normalized.id,
        chatId: chat.id,
        senderJid: normalized.senderJid,
        messageType: normalized.type,
        body: normalized.body,
        quotedMessageId,
        quotedWhatsappMessageId: normalized.quoted?.id || null,
        sentAt: normalized.sentAt,
        receivedAt: normalized.receivedAt,
        isCommand: normalized.isCommand,
      });

      let attachment = null;
      if (messageResult.created && normalized.media) {
        const metadata = normalized.media;
        attachment = this.repositories.attachments.create({
          idempotencyKey: `${normalized.id}:media:0`,
          messageId: messageResult.record.id,
          displayName: metadata.fileName || `whatsapp-${metadata.type || 'media'}-${normalized.id}`,
          // This is transport-declared MIME metadata. Task 8 will replace/verify it
          // using magic bytes before parsing or archiving the payload.
          detectedMime: metadata.mimeType,
          sizeBytes: metadata.sizeBytes ?? 0,
          processingStatus: 'PENDING',
          now: normalized.receivedAt,
        }).record;
      }
      return { ...messageResult, attachment };
    });
  }

  async handle(normalized, message) {
    // Boundary check intentionally precedes dedupe, persistence, media access,
    // AI, and all legacy behavior. A duplicate ID from another chat cannot use
    // the fast filter to bypass authorization.
    const chat = this.permissionService.assertAuthorizedChat(normalized.chatJid);
    if (this.isDuplicate(normalized.id)) {
      this.logger.warn?.(`Ignoring duplicate WhatsApp event (fast filter): ${normalized.id}`);
      return { accepted: true, duplicate: true, source: 'memory' };
    }

    // The UNIQUE whatsapp_message_id constraint is the durable claim. Routing is
    // at-most-once: a crash/restart replay observes created=false and cannot repeat
    // a command, outbound send, AI call, or other legacy business side effect.
    const persisted = this.persist(normalized, chat);
    if (!persisted.created) {
      this.logger.warn?.(`Ignoring duplicate WhatsApp event (SQLite): ${normalized.id}`);
      return { accepted: true, duplicate: true, source: 'sqlite', record: persisted.record };
    }

    await this.route(message, normalized, persisted.record);
    return {
      accepted: true,
      duplicate: false,
      source: 'sqlite',
      record: persisted.record,
      attachment: persisted.attachment,
    };
  }
}

function createMessageEventHandler(options = {}) {
  if (typeof options.routeLegacy !== 'function') throw new TypeError('routeLegacy is required');
  if (!options.ingress || typeof options.ingress.handle !== 'function') {
    throw new TypeError('authorized group ingress is required');
  }
  if (!options.adapter || typeof options.adapter.wrapIncoming !== 'function') {
    throw new TypeError('WhatsApp adapter is required');
  }
  const normalizer = options.normalize || normalizeMessage;
  const isDuplicate = options.isDuplicate || (() => false);
  const clock = options.clock || Date.now;

  return async function onMessage(rawMessage) {
    const normalized = normalizer(rawMessage, { receivedAt: clock() });
    const message = options.adapter.wrapIncoming(rawMessage, normalized);

    if (normalized.isGroup) {
      return options.ingress.handle(normalized, message);
    }

    // Existing direct-chat behavior remains available but PM persistence is
    // deliberately group-scoped. Its existing in-memory deduper still protects
    // reconnect bursts; SQLite remains authoritative for the authorized group.
    if (isDuplicate(normalized.id)) {
      return { accepted: true, duplicate: true, source: 'memory-direct' };
    }
    await options.routeLegacy(message, normalized, null);
    return { accepted: true, duplicate: false, source: 'legacy-direct' };
  };
}

module.exports = { AuthorizedGroupIngress, createMessageEventHandler };
