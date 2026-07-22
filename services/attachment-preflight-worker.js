'use strict';

const crypto = require('crypto');
const { parentPort } = require('worker_threads');
const { detectAttachmentType } = require('./attachment-type');

if (!parentPort) throw new Error('attachment-preflight-worker must run in a worker thread');

parentPort.once('message', async (input) => {
  try {
    const buffer = Buffer.from(input.buffer);
    const detected = await detectAttachmentType(buffer, input.metadata, input.limits);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    parentPort.postMessage({ ok: true, detected, sha256 });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        name: error?.name || 'Error',
        code: error?.code || 'PREFLIGHT_FAILED',
        message: String(error?.message || 'Attachment preflight failed').slice(0, 2000),
        retryable: error?.retryable === true,
      },
    });
  }
});
