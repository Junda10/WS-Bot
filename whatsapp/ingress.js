'use strict';

const crypto = require('crypto');
const { normalizeMessage } = require('./normalize-message');

const DEFAULT_PROCESSING_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 1000;

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
    this.clock = options.clock || Date.now;
    this.processingLeaseMs = options.processingLeaseMs ?? DEFAULT_PROCESSING_LEASE_MS;
    if (!Number.isSafeInteger(this.processingLeaseMs) || this.processingLeaseMs < 1) {
      throw new TypeError('processingLeaseMs must be a positive safe integer');
    }
    this.activeMessageIds = new Set();
  }

  accepts(chatJid) {
    return chatJid === this.permissionService.authorizedChatJid;
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
        senderDisplayName: normalized.senderDisplayName,
        messageType: normalized.type,
        body: normalized.body,
        quotedMessageId,
        quotedWhatsappMessageId: normalized.quoted?.id || null,
        quotedBody: normalized.quoted?.body ?? null,
        quotedSenderJid: normalized.quoted?.senderJid || null,
        quotedSentAt: normalized.quoted?.sentAt ?? null,
        quotedMedia: normalized.quoted?.media ?? null,
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

  _now(notBefore = 0) {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('ingress clock must return a non-negative safe integer');
    }
    return Math.max(value, notBefore);
  }

  _rememberProcessed(messageId) {
    if (typeof this.isDuplicate.remember === 'function') {
      this.isDuplicate.remember(messageId);
    } else {
      this.isDuplicate(messageId);
    }
  }

  async handle(normalized, message) {
    // Only this ingress is authorization-scoped. The dispatcher deliberately
    // sends every other group/direct chat to the unchanged legacy route.
    const chat = this.permissionService.assertAuthorizedChat(normalized.chatJid);

    // Persistence always precedes the durable claim. A memory hit is advisory
    // only and is never allowed to hide PENDING, FAILED, or stale PROCESSING.
    const persisted = this.persist(normalized, chat);
    const knownProcessed = persisted.record.processing_status === 'PROCESSED';
    const memoryDuplicate = typeof this.isDuplicate.has === 'function'
      ? this.isDuplicate.has(normalized.id)
      : false;
    if (knownProcessed) {
      this._rememberProcessed(normalized.id);
      this.logger.warn?.(`Ignoring processed WhatsApp event (${memoryDuplicate ? 'memory' : 'SQLite'}): ${normalized.id}`);
      return {
        accepted: true,
        duplicate: true,
        source: memoryDuplicate ? 'memory' : 'sqlite',
        record: persisted.record,
      };
    }

    if (this.activeMessageIds.has(normalized.id)) {
      return {
        accepted: true,
        duplicate: true,
        source: 'ingress-processing',
        record: this.repositories.messages.findById(persisted.record.id),
      };
    }

    const claimNow = this._now(normalized.receivedAt);
    const claimed = this.repositories.messages.claimProcessing(persisted.record.id, {
      now: claimNow,
      leaseMs: this.processingLeaseMs,
      claimId: crypto.randomUUID(),
    });
    if (!claimed) {
      const current = this.repositories.messages.findById(persisted.record.id);
      // Another live handler owns the lease. This is the process- and
      // database-wide concurrency gate protecting legacy side effects.
      return {
        accepted: true,
        duplicate: true,
        source: current?.processing_status === 'PROCESSING' ? 'sqlite-processing' : 'sqlite',
        record: current,
      };
    }

    this.activeMessageIds.add(normalized.id);
    try {
      try {
        await this.route(message, normalized, claimed);
      } catch (routeError) {
        try {
          const failed = this.repositories.messages.markFailed(
            claimed.id,
            claimed.processing_claim_id,
            routeError,
            this._now(claimNow)
          );
          if (!failed) {
            this.logger.error?.(`Lost processing claim while recording failure: ${normalized.id}`);
          }
        } catch (markError) {
          this.logger.error?.(
            `Could not record failed WhatsApp route ${normalized.id}: ${markError.message}`
          );
        }
        if (typeof this.isDuplicate.forget === 'function') this.isDuplicate.forget(normalized.id);
        throw routeError;
      }

      const processed = this.repositories.messages.markProcessed(
        claimed.id,
        claimed.processing_claim_id,
        this._now(claimNow)
      );
      if (!processed) {
        throw new Error(`Lost processing claim before completion: ${normalized.id}`);
      }
      this._rememberProcessed(normalized.id);
      return {
        accepted: true,
        duplicate: false,
        source: 'sqlite',
        record: processed,
        attachment: persisted.attachment,
      };
    } finally {
      this.activeMessageIds.delete(normalized.id);
    }
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
  let accepting = true;
  const inFlight = new Set();

  async function dispatch(rawMessage) {
    const normalized = normalizer(rawMessage, { receivedAt: clock() });
    const message = options.adapter.wrapIncoming(rawMessage, normalized);

    const isAuthorizedGroup = normalized.isGroup
      && (typeof options.ingress.accepts === 'function'
        ? options.ingress.accepts(normalized.chatJid)
        : true);
    if (isAuthorizedGroup) return options.ingress.handle(normalized, message);

    // PM persistence/authorization is scoped only to the configured group.
    // Direct chats and every other group retain the pre-Task-5 legacy route.
    if (isDuplicate(normalized.id)) {
      return { accepted: true, duplicate: true, source: 'memory-legacy' };
    }
    try {
      await options.routeLegacy(message, normalized, null);
    } catch (error) {
      // A failed legacy route is unfinished and must not be suppressed on a
      // transport retry merely because its ID entered the memory fast filter.
      if (typeof isDuplicate.forget === 'function') isDuplicate.forget(normalized.id);
      throw error;
    }
    return {
      accepted: true,
      duplicate: false,
      source: normalized.isGroup ? 'legacy-group' : 'legacy-direct',
    };
  }

  function onMessage(rawMessage) {
    if (!accepting) {
      return Promise.resolve({ accepted: false, duplicate: false, source: 'stopping' });
    }
    const operation = Promise.resolve().then(() => dispatch(rawMessage));
    inFlight.add(operation);
    const remove = () => inFlight.delete(operation);
    operation.then(remove, remove);
    return operation;
  }

  onMessage.stopAccepting = () => {
    accepting = false;
    return inFlight.size;
  };
  onMessage.isAccepting = () => accepting;
  onMessage.inFlightCount = () => inFlight.size;
  onMessage.drain = async ({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) => {
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
      throw new TypeError('drain timeoutMs must be null or a non-negative safe integer');
    }
    const pending = [...inFlight];
    if (pending.length === 0) return { drained: true, timedOut: false, remaining: 0 };

    const settled = Promise.allSettled(pending).then(() => 'settled');
    if (timeoutMs === null) {
      await settled;
      return { drained: true, timedOut: false, remaining: inFlight.size };
    }

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    return {
      drained: result === 'settled',
      timedOut: result === 'timeout',
      remaining: inFlight.size,
    };
  };

  return onMessage;
}

module.exports = {
  AuthorizedGroupIngress,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_PROCESSING_LEASE_MS,
  createMessageEventHandler,
};
