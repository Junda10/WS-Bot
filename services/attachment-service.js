'use strict';

const crypto = require('crypto');
const { ACTIONS } = require('./permission-service');
const {
  AttachmentValidationError,
  inferredDisplayName,
  sanitizeDisplayName,
} = require('./attachment-type');
const { AttachmentStorageError } = require('./attachment-storage');
const { AttachmentPreflightProcessor } = require('./attachment-preflight-processor');
const { MediaDownloadError } = require('../whatsapp/adapter');

class AttachmentProcessingError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AttachmentProcessingError';
    this.code = code;
    this.retryable = options.retryable !== false;
  }
}

function errorDetails(error) {
  if (error instanceof AttachmentValidationError
      || error instanceof AttachmentStorageError
      || error instanceof MediaDownloadError
      || error instanceof AttachmentProcessingError
      || typeof error?.code === 'string') {
    return {
      code: String(error.code || 'PROCESSING_FAILED').slice(0, 100),
      message: String(error.message || 'Attachment processing failed').slice(0, 2000),
      retryable: error.retryable === true,
    };
  }
  return {
    code: 'PROCESSING_FAILED',
    message: String(error?.message || 'Attachment processing failed').slice(0, 2000),
    retryable: true,
  };
}

/**
 * Apply one deadline to the complete job. On timeout, abort cooperative work,
 * but do not settle until the underlying operation has actually stopped. This
 * keeps the queue's concurrency slot occupied for non-abortable WhatsApp calls.
 */
async function withTimeout(work, timeoutMs) {
  if (typeof work !== 'function') throw new TypeError('withTimeout requires a work function');
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const operation = Promise.resolve().then(() => work(controller.signal));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ timeout: true });
    }, timeoutMs);
    timer.unref?.();
  });
  const outcome = await Promise.race([
    operation.then(
      (value) => ({ value }),
      (error) => ({ error })
    ),
    timeout,
  ]);
  clearTimeout(timer);
  if (outcome.timeout) {
    // downloadMedia() currently has no abort contract. Waiting here is
    // intentional: releasing the queue slot early would violate concurrency.
    await operation.catch(() => {});
    throw new AttachmentProcessingError(
      'PROCESSING_TIMEOUT',
      `Attachment processing exceeded ${timeoutMs}ms`
    );
  }
  if (outcome.error) {
    if (timedOut || (controller.signal.aborted && outcome.error?.name === 'AbortError')) {
      throw new AttachmentProcessingError(
        'PROCESSING_TIMEOUT',
        `Attachment processing exceeded ${timeoutMs}ms`
      );
    }
    throw outcome.error;
  }
  return outcome.value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Attachment processing aborted');
  error.name = 'AbortError';
  error.code = 'PROCESSING_TIMEOUT';
  error.retryable = true;
  throw error;
}

class AttachmentService {
  constructor(options = {}) {
    if (!options.repositories?.attachments || !options.repositories?.messages) {
      throw new TypeError('AttachmentService requires attachment/message repositories');
    }
    if (!options.permissionService?.authorize) {
      throw new TypeError('AttachmentService requires PermissionService');
    }
    if (!options.issueService?.attachmentsForRetry) {
      throw new TypeError('AttachmentService requires IssueService');
    }
    if (!options.storage?.stageBuffer || !options.storage?.commitStaged) {
      throw new TypeError('AttachmentService requires AttachmentStorage');
    }
    if (!options.queue?.enqueue) throw new TypeError('AttachmentService requires a processing queue');
    if (!options.adapter?.downloadAttachment) {
      throw new TypeError('AttachmentService requires WhatsAppAdapter download support');
    }
    this.repositories = options.repositories;
    this.permissions = options.permissionService;
    this.issues = options.issueService;
    this.storage = options.storage;
    this.queue = options.queue;
    this.adapter = options.adapter;
    this.processor = options.processor || new AttachmentPreflightProcessor();
    if (typeof this.processor.process !== 'function') {
      throw new TypeError('Attachment processor must provide process(buffer, metadata, limits, options)');
    }
    this.limits = Object.freeze({ ...options.limits });
    this.clock = options.clock || Date.now;
    this.logger = options.logger || console;
    this.enqueued = new Map();
    this.recoveryTimer = null;
    this.recoveryInProgress = null;
  }

  now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('AttachmentService clock must return a non-negative safe integer');
    }
    return value;
  }

  _downloadOptions(attachment, extra = {}) {
    return {
      maxBytes: this.limits.maxFileBytes,
      mimeType: attachment.declared_mime,
      fileName: attachment.display_name,
      sizeBytes: attachment.size_bytes,
      ...extra,
    };
  }

  _admit(attachmentId, downloader, metadata = {}) {
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) {
      throw new TypeError('attachmentId must be a positive safe integer');
    }
    if (typeof downloader !== 'function') throw new TypeError('attachment downloader must be a function');
    const active = this.enqueued.get(attachmentId);
    if (active) return { ...active, admitted: false };

    const claimId = crypto.randomUUID();
    const claimed = this.repositories.attachments.claimForQueue({
      attachmentId,
      claimId,
      now: this.now(),
    });
    if (!claimed) {
      throw new AttachmentProcessingError(
        'ATTACHMENT_NOT_RECOVERABLE',
        'Attachment is already queued, actively processing, deleted, or not retryable',
        { retryable: false }
      );
    }

    let operation;
    try {
      operation = this.queue.enqueue(
        () => this._process(attachmentId, claimId, downloader),
        { attachmentId, claimId, ...metadata }
      );
    } catch (error) {
      const details = errorDetails(error);
      this.repositories.attachments.markAdmissionFailed({
        attachmentId,
        claimId,
        code: details.code,
        message: details.message,
        retryable: details.retryable,
        now: this.now(),
      });
      throw error;
    }
    const admission = { operation, claimId, admitted: true };
    this.enqueued.set(attachmentId, admission);
    operation.finally(() => {
      if (this.enqueued.get(attachmentId)?.claimId === claimId) this.enqueued.delete(attachmentId);
    }).catch(() => {});
    return admission;
  }

  enqueue(attachmentId, downloader, metadata = {}) {
    return this._admit(attachmentId, downloader, metadata).operation;
  }

  recordCaptureFailure(attachmentId, error) {
    const details = errorDetails(error);
    return this.repositories.attachments.markCaptureFailed({
      attachmentId,
      code: details.code,
      message: details.message,
      retryable: details.retryable,
      now: this.now(),
    });
  }

  captureIncoming(input) {
    const attachment = input.attachment;
    if (!attachment || !input.message) return null;
    this.permissions.assertAuthorizedChat(input.normalized?.chatJid);
    return this.enqueue(
      attachment.id,
      (signal) => this.adapter.downloadAttachment(input.message, this._downloadOptions(attachment, {
        signal,
        expectedMessageId: input.normalized?.id,
        expectedChatJid: input.normalized?.chatJid,
      })),
      { source: 'incoming' }
    );
  }

  captureQuoted(input) {
    const principal = this.permissions.authorize(ACTIONS.DOWNLOAD, {
      chatJid: input.normalized?.chatJid,
      actorJid: input.normalized?.senderJid,
    });
    const quoted = input.normalized?.quoted;
    if (!quoted?.id || quoted.chatJid !== principal.chat.jid || !quoted.media) {
      throw new AttachmentProcessingError(
        'QUOTED_MEDIA_UNAVAILABLE',
        'The quoted message has no attachment in the authorized chat',
        { retryable: false }
      );
    }
    const commandMessageId = input.persisted?.id;
    if (!Number.isSafeInteger(commandMessageId)) {
      throw new TypeError('Persisted command message is required for quoted attachment capture');
    }
    const metadata = quoted.media;
    const result = this.repositories.attachments.create({
      idempotencyKey: `${input.normalized.id}:quoted-media:${quoted.id}`,
      messageId: commandMessageId,
      issueId: input.issueId,
      mediaWhatsappMessageId: quoted.id,
      displayName: sanitizeDisplayName(metadata.fileName),
      declaredMime: metadata.mimeType,
      sizeBytes: metadata.sizeBytes ?? 0,
      retentionClass: input.issueId ? 'ISSUE' : 'TEMPORARY',
      processingStatus: 'PENDING',
      now: this.now(),
    });
    const operation = this.enqueue(
      result.record.id,
      (signal) => this.adapter.downloadQuotedAttachment(input.message, this._downloadOptions(result.record, {
        signal,
        expectedMessageId: quoted.id,
        expectedChatJid: principal.chat.jid,
      })),
      { source: 'quoted' }
    );
    return { attachment: result.record, created: result.created, operation };
  }

  retryIssue(input) {
    const selected = this.issues.attachmentsForRetry({ ...input, now: this.now() });
    const queued = [];
    const inFlight = [];
    const failedAdmissions = [];
    for (const attachment of selected.attachments) {
      const sourceId = attachment.media_whatsapp_message_id || attachment.source_whatsapp_message_id;
      try {
        const admission = this._admit(
          attachment.id,
          (signal) => this.adapter.downloadAttachmentByMessageId(
            sourceId,
            this._downloadOptions(attachment, {
              signal,
              expectedMessageId: sourceId,
              expectedChatJid: selected.chatJid,
            })
          ),
          { source: 'retry', issueId: selected.issue.id }
        );
        admission.operation.catch((error) => {
          this.logger.warn?.(`Attachment retry ${attachment.id} failed (${errorDetails(error).code})`);
        });
        if (admission.admitted) queued.push(attachment.id);
        else inFlight.push(attachment.id);
      } catch (error) {
        failedAdmissions.push({ attachmentId: attachment.id, ...errorDetails(error) });
      }
    }
    return {
      issue: selected.issue,
      attachmentIds: queued,
      inFlightAttachmentIds: inFlight,
      failedAdmissions,
    };
  }

  async _process(attachmentId, claimId, downloader) {
    let attempt = null;
    let stage = null;
    let committed = null;
    try {
      const result = await withTimeout(async (signal) => {
        const attachment = this.repositories.attachments.findById(attachmentId);
        if (!attachment) {
          throw new AttachmentProcessingError('ATTACHMENT_NOT_FOUND', 'Attachment no longer exists');
        }
        const startedAt = this.now();
        const leaseUntil = startedAt + this.limits.processingTimeoutMs + 5000;
        attempt = this.repositories.attachments.startAttempt({
          attachmentId,
          operation: 'DOWNLOAD',
          claimId,
          leaseUntil,
          idempotencyKey: `attachment:${attachmentId}:claim:${claimId}`,
          now: startedAt,
        }).record;
        this._scheduleRecoveryAt(leaseUntil);
        throwIfAborted(signal);
        const downloaded = await downloader(signal);
        throwIfAborted(signal);
        if (!downloaded || !Buffer.isBuffer(downloaded.buffer)) {
          throw new AttachmentProcessingError('DOWNLOAD_INVALID', 'Downloader returned no attachment bytes');
        }
        if (downloaded.buffer.length > this.limits.maxFileBytes) {
          throw new AttachmentValidationError('FILE_TOO_LARGE', 'Attachment exceeds configured byte limit');
        }

        stage = await this.storage.stageBuffer(downloaded.buffer, {
          maxBytes: this.limits.maxFileBytes,
        });
        throwIfAborted(signal);
        const declaredMime = downloaded.mimeType || attachment.declared_mime;
        const sourceDisplayName = sanitizeDisplayName(downloaded.fileName || attachment.display_name);
        const preflight = await this.processor.process(downloaded.buffer, {
          fileName: sourceDisplayName,
          mimeType: declaredMime,
        }, this.limits, { signal });
        throwIfAborted(signal);
        const displayName = inferredDisplayName(sourceDisplayName, preflight.detected);
        committed = await this.storage.commitStaged(stage, {
          issueId: attachment.issue_id,
          extension: preflight.detected.extension,
          sha256: preflight.sha256,
        });
        stage = null;
        throwIfAborted(signal);
        const finalized = this.repositories.attachments.finalizeProcessingSuccess({
          attemptId: attempt.id,
          attachmentId,
          sha256: preflight.sha256,
          storageKey: committed.storageKey,
          sizeBytes: downloaded.buffer.length,
          detectedMime: preflight.detected.mime,
          detectedExtension: preflight.detected.extension,
          displayName,
          retentionClass: attachment.issue_id ? 'ISSUE' : 'TEMPORARY',
          metadata: {
            detectedKind: preflight.detected.kind,
            imagePixels: preflight.detected.pixels ?? null,
            docxUncompressedBytes: preflight.detected.docx?.uncompressedBytes ?? null,
          },
          now: this.now(),
        });
        if (attachment.issue_id && /^temporary[\\/]/u.test(finalized.blob.storage_key)) {
          await this._promoteBlobForAttachment({
            attachmentId,
            issueId: attachment.issue_id,
            blob: finalized.blob,
          });
          finalized.blob = this.repositories.attachments.findBlob(preflight.sha256);
        }
        return { ...finalized, detected: preflight.detected };
      }, this.limits.processingTimeoutMs);

      if (result.orphanStorageKey) {
        try { await this.storage.remove(result.orphanStorageKey); } catch (cleanupError) {
          this.logger.error?.(`Deduplicated blob cleanup failed: ${cleanupError.message}`);
        }
      }
      return { ...result, deduplicated: result.deduplicated };
    } catch (error) {
      if (stage) {
        try { await this.storage.discard(stage); } catch (cleanupError) {
          this.logger.error?.(`Attachment staging cleanup failed: ${cleanupError.message}`);
        }
      }
      // commitStaged exposes a post-rename destination even when its first
      // best-effort unlink failed. Retry through the validated storage API; if
      // this also fails, startup orphan reconciliation still sees the key.
      if (!committed && error?.destinationStorageKey) {
        try { await this.storage.remove(error.destinationStorageKey); } catch (cleanupError) {
          this.logger.error?.(
            `Attachment post-rename reconciliation failed for ${error.destinationStorageKey}: ${cleanupError.message}`
          );
        }
      }
      // A committed candidate that was not transactionally referenced is an
      // orphan and can be removed. If the DB transaction did commit, the
      // attempt is no longer STARTED and startup reconciliation preserves it.
      if (committed && attempt) {
        const currentAttempt = this.repositories.attachments.listAttempts(attachmentId)
          .find((row) => row.id === attempt.id);
        if (currentAttempt?.status === 'STARTED') {
          try { await this.storage.remove(committed.storageKey); } catch (cleanupError) {
            this.logger.error?.(`Attachment orphan cleanup failed: ${cleanupError.message}`);
          }
        }
      }
      const details = errorDetails(error);
      if (attempt) {
        try {
          this.repositories.attachments.completeAttempt({
            attemptId: attempt.id,
            status: 'FAILED',
            errorCode: details.code,
            errorMessage: details.message,
            retryable: details.retryable,
            now: this.now(),
          });
        } catch (persistError) {
          // A success transaction may have won just before a post-commit error.
          const current = this.repositories.attachments.listAttempts(attachmentId)
            .find((row) => row.id === attempt.id);
          if (current?.status !== 'SUCCEEDED') {
            this.logger.error?.(`Could not persist attachment failure ${attachmentId}: ${persistError.message}`);
          }
        }
      }
      throw error;
    }
  }

  _scheduleRecoveryAt(leaseUntil) {
    if (!Number.isSafeInteger(leaseUntil) || leaseUntil < 0) return;
    if (this.recoveryTimer && this.recoveryTimerAt <= leaseUntil) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimerAt = leaseUntil;
    const delay = Math.max(1, leaseUntil - this.now());
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.recoveryTimerAt = null;
      this.recoverPending().catch((error) => {
        this.logger.error?.(`Scheduled attachment recovery failed: ${error.message}`);
        this._scheduleRecoveryAt(this.now() + 5000);
      });
    }, delay);
    this.recoveryTimer.unref?.();
  }

  stopRecovery() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryTimerAt = null;
  }

  async _reconcilePromotion(blob) {
    try {
      await this.storage.reconcilePromotion(blob.storage_key, blob.promotion_target_key);
    } catch (error) {
      if (!error?.requiresReconciliation) throw error;
      // A post-rename chmod/fsync error leaves a durable intent and destination.
      // Re-observe both paths instead of attempting a dangerous rollback.
      await this.storage.reconcilePromotion(blob.storage_key, blob.promotion_target_key);
    }
    return this.repositories.attachments.completeBlobPromotion({
      sha256: blob.sha256,
      targetKey: blob.promotion_target_key,
      now: this.now(),
    });
  }

  async _recoverPending() {
    const promotionErrors = [];
    const pendingHashes = new Set();
    for (const blob of this.repositories.attachments.listPendingBlobPromotions()) {
      try {
        await this._reconcilePromotion(blob);
      } catch (error) {
        pendingHashes.add(blob.sha256);
        const details = { sha256: blob.sha256, ...errorDetails(error) };
        promotionErrors.push(details);
        this.logger.error?.(`Attachment promotion recovery failed for ${blob.sha256}: ${details.message}`);
      }
    }

    const missing = [];
    for (const blob of this.repositories.attachments.listBlobs()) {
      if (pendingHashes.has(blob.sha256)) continue;
      try { this.storage.resolve(blob.storage_key); } catch (error) {
        this.logger.error?.(`Attachment blob ${blob.sha256} is missing or unsafe: ${error.message}`);
        missing.push(this.repositories.attachments.reconcileMissingBlob(blob.sha256, this.now()));
      }
    }
    const currentBlobs = this.repositories.attachments.listBlobs();
    const liveKeys = currentBlobs.flatMap((blob) => [
      blob.storage_key,
      ...(blob.promotion_target_key ? [blob.promotion_target_key] : []),
    ]);
    const orphanCleanup = await this.storage.cleanupOrphans(liveKeys, { logger: this.logger });
    const activeClaimIds = [...this.enqueued.values()].map((entry) => entry.claimId);
    const recovery = this.repositories.attachments.recoverForStartup(this.now(), activeClaimIds);
    if (recovery.nextLeaseUntil !== null) this._scheduleRecoveryAt(recovery.nextLeaseUntil);
    const queued = [];
    const inFlight = [];
    const failedAdmissions = [];
    for (const attachment of recovery.recoverable) {
      const sourceId = attachment.media_whatsapp_message_id || attachment.source_whatsapp_message_id;
      try {
        const admission = this._admit(
          attachment.id,
          (signal) => this.adapter.downloadAttachmentByMessageId(sourceId, this._downloadOptions(attachment, {
            signal,
            expectedMessageId: sourceId,
            expectedChatJid: attachment.chat_jid,
          })),
          { source: 'startup-recovery' }
        );
        admission.operation.catch((error) => this.logger.warn?.(
          `Recovered attachment ${attachment.id} failed (${errorDetails(error).code})`
        ));
        if (admission.admitted) queued.push(attachment.id);
        else inFlight.push(attachment.id);
      } catch (error) {
        failedAdmissions.push({ attachmentId: attachment.id, ...errorDetails(error) });
      }
    }
    return {
      queued,
      inFlightAttachmentIds: inFlight,
      failedAdmissions,
      missing,
      removedOrphans: orphanCleanup.removed,
      quarantinedOrphans: orphanCleanup.quarantined,
      orphanErrors: orphanCleanup.errors,
      promotionErrors,
      nextLeaseUntil: recovery.nextLeaseUntil,
    };
  }

  recoverPending() {
    if (this.recoveryInProgress) return this.recoveryInProgress;
    this.recoveryInProgress = this._recoverPending().finally(() => {
      this.recoveryInProgress = null;
    });
    return this.recoveryInProgress;
  }

  async cleanupBlob(sha256) {
    const blob = this.repositories.attachments.deleteBlobIfUnreferenced(sha256);
    if (!blob) return { removed: false, reason: 'REFERENCES_OR_MISSING' };
    await this.storage.remove(blob.storage_key);
    return { removed: true, blob };
  }

  async purgeTemporaryBlob(sha256) {
    const purged = this.repositories.attachments.purgeTemporaryBlob(sha256);
    if (!purged) return { removed: false, reason: 'INELIGIBLE_OR_MISSING' };
    await this.storage.remove(purged.blob.storage_key);
    return { removed: true, ...purged };
  }

  async _promoteBlobForAttachment(input) {
    let blob = input.blob || this.repositories.attachments.findBlob(
      this.repositories.attachments.findById(input.attachmentId)?.blob_sha256
    );
    if (!blob) throw new AttachmentProcessingError('ATTACHMENT_UNAVAILABLE', 'Attachment blob is missing');
    const isTemporaryPath = /^temporary[\\/]/u.test(blob.storage_key);
    if (!blob.promotion_target_key && !isTemporaryPath) {
      return this.repositories.transaction((tx) => {
        const linked = tx.attachments.linkToIssue(input.attachmentId, input.issueId, this.now());
        tx.attachments.recomputeBlobRetention(blob.sha256, this.now());
        return linked;
      });
    }
    const targetKey = blob.promotion_target_key
      || await this.storage.promotionTarget(blob.storage_key, input.issueId);
    const intent = this.repositories.attachments.beginBlobPromotion({
      attachmentId: input.attachmentId,
      issueId: input.issueId,
      targetKey,
      now: this.now(),
    });
    blob = intent.blob;
    await this._reconcilePromotion(blob);
    return this.repositories.attachments.findById(input.attachmentId);
  }

  async promoteToIssue(input) {
    const principal = this.permissions.authorize(ACTIONS.UPDATE_ISSUE, {
      chatJid: input.chatJid,
      actorJid: input.actorJid,
    });
    const attachment = this.repositories.attachments.findById(input.attachmentId);
    if (!attachment || attachment.chat_id !== principal.chat.id) {
      throw new AttachmentProcessingError('ATTACHMENT_NOT_FOUND', 'Attachment not found in the authorized chat', {
        retryable: false,
      });
    }
    const issue = this.repositories.issues.findById(input.issueId);
    if (!issue || issue.chat_id !== principal.chat.id) {
      throw new AttachmentProcessingError('ISSUE_NOT_FOUND', 'Issue is unavailable or belongs to another chat', {
        retryable: false,
      });
    }
    if (!attachment.blob_sha256 || !attachment.storage_key) {
      throw new AttachmentProcessingError('ATTACHMENT_UNAVAILABLE', 'Attachment has no secure archive', {
        retryable: false,
      });
    }
    return this._promoteBlobForAttachment({
      attachmentId: attachment.id,
      issueId: issue.id,
      blob: this.repositories.attachments.findBlob(attachment.blob_sha256),
    });
  }
}

module.exports = {
  AttachmentProcessingError,
  AttachmentService,
  errorDetails,
  withTimeout,
};
