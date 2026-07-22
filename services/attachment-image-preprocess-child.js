'use strict';

const { AttachmentImagePreprocessor } = require('./attachment-image-preprocessor');

function send(message) {
  if (typeof process.send !== 'function' || !process.connected) return Promise.resolve();
  return new Promise((resolve) => process.send(message, () => resolve()));
}

function serializeError(error) {
  return {
    code: error?.code || 'IMAGE_DECODE_FAILED',
    message: String(error?.message || error || 'Image preprocessing failed').slice(0, 1500),
    retryable: error?.retryable === true,
  };
}

process.once('message', async (message) => {
  try {
    const preprocessor = new AttachmentImagePreprocessor({ isolate: false });
    const result = await preprocessor.preprocess(message.input, message.limits);
    await send({ ok: true, result });
  } catch (error) {
    await send({ ok: false, error: serializeError(error) });
  } finally {
    // Exactly one untrusted decode is allowed per resource-limited process.
    process.disconnect?.();
  }
});
