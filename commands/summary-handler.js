'use strict';

const { SummaryWindowError } = require('../summaries/manual-window');

function createSummaryHandler({ summaryService, adapter } = {}) {
  if (!summaryService || typeof summaryService.build !== 'function') {
    throw new TypeError('summaryService.build is required');
  }
  if (!adapter || typeof adapter.sendParts !== 'function') {
    throw new TypeError('adapter.sendParts is required');
  }

  return async function summaryHandler(context) {
    let result;
    try {
      result = await summaryService.build({
        chatId: context.chat.id,
        tokens: context.parsed.tokens,
        now: context.now,
      });
    } catch (error) {
      if (!(error instanceof SummaryWindowError)) throw error;
      await context.reply(`⚠️ ${error.message}\n发送 !summary help 查看用法。`);
      return Object.freeze({ ok: false, validationError: error.code });
    }

    // Do not create or claim a summary run here. The durable inbound command
    // remains FAILED/retryable if any send rejects; ingress marks it PROCESSED
    // only after every part below succeeds.
    const receipts = await adapter.sendParts(context.normalized.chatJid, result.parts, {
      quotedMessageId: context.normalized.id,
    });
    return Object.freeze({
      ok: true,
      partCount: result.parts.length,
      receipts: Object.freeze(receipts),
      window: result.window,
    });
  };
}

module.exports = { createSummaryHandler };
