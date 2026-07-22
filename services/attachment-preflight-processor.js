'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { AttachmentValidationError } = require('./attachment-type');

class AttachmentPreflightProcessor {
  constructor(options = {}) {
    this.Worker = options.Worker || Worker;
    this.workerPath = options.workerPath || path.join(__dirname, 'attachment-preflight-worker.js');
  }

  process(buffer, metadata, limits, options = {}) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('Attachment preflight requires a Buffer');
    const signal = options.signal;
    if (signal?.aborted) {
      const error = new Error('Attachment preflight was aborted');
      error.name = 'AbortError';
      error.code = 'PROCESSING_TIMEOUT';
      error.retryable = true;
      return Promise.reject(error);
    }
    const worker = new this.Worker(this.workerPath);
    return new Promise((resolve, reject) => {
      let settled = false;
      let terminating = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => {
        const error = new Error('Attachment preflight was aborted');
        error.name = 'AbortError';
        error.code = 'PROCESSING_TIMEOUT';
        error.retryable = true;
        terminating = true;
        // terminate() can reject (custom Worker implementations and shutdown
        // races do this). Consume either outcome before settling the caller so
        // no detached rejection escapes the processing job.
        worker.terminate().then(
          () => finish(reject, error),
          () => finish(reject, error)
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (result) => {
        worker.terminate().catch(() => {});
        if (result?.ok) {
          finish(resolve, Object.freeze({ ...result, detected: Object.freeze(result.detected) }));
          return;
        }
        const details = result?.error || {};
        const error = new AttachmentValidationError(
          details.code || 'PREFLIGHT_FAILED',
          details.message || 'Attachment preflight failed',
          { retryable: details.retryable === true }
        );
        finish(reject, error);
      });
      worker.once('error', (error) => finish(reject, error));
      worker.once('exit', (code) => {
        if (!settled && !terminating && code !== 0) {
          finish(reject, new Error(`Attachment preflight worker exited ${code}`));
        }
      });
      worker.postMessage({ buffer, metadata, limits });
    });
  }
}

module.exports = { AttachmentPreflightProcessor };
