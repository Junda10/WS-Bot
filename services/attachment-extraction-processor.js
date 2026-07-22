'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { Worker } = require('worker_threads');
const { AttachmentExtractionError } = require('./attachment-extractors');

class AttachmentExtractionProcessor {
  constructor(options = {}) {
    this.Worker = options.Worker || Worker;
    this.fork = options.fork || fork;
    this.workerPath = options.workerPath || path.join(__dirname, 'attachment-extraction-worker.js');
    this.pdfChildPath = options.pdfChildPath || path.join(__dirname, 'attachment-pdf-child.js');
  }

  process(filePath, metadata = {}, limits = {}, options = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return Promise.reject(new TypeError('Attachment extraction requires an absolute canonical file path'));
    }
    let canonical;
    try {
      canonical = fs.realpathSync(filePath);
      if (canonical !== path.resolve(filePath)) {
        throw new TypeError('Attachment extraction path must already be canonical');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(this._abortError());
    return String(metadata.kind || '').toLowerCase() === 'pdf'
      ? this._processPdf(canonical, metadata, limits, options)
      : this._processWorker(canonical, metadata, limits, options);
  }

  _processWorker(filePath, metadata, limits, options) {
    const memoryMb = this._memoryLimit(limits);
    const worker = new this.Worker(this.workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.max(4, Math.min(16, Math.floor(memoryMb / 4))),
        stackSizeMb: 4,
      },
    });
    return this._awaitIsolate({
      isolate: worker,
      signal: options.signal,
      timeoutMs: this._timeout(limits),
      send: () => worker.postMessage({ filePath, metadata, limits }),
      stop: () => worker.terminate(),
      exitEvent: 'exit',
      errorEvent: 'error',
      exitCode: (value) => value,
      label: 'Attachment extraction worker',
      exitCodeName: 'PARSER_WORKER_EXIT',
    });
  }

  _processPdf(filePath, metadata, limits, options) {
    const memoryMb = this._memoryLimit(limits);
    const child = this.fork(this.pdfChildPath, [], {
      execArgv: [`--max-old-space-size=${memoryMb}`],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    return this._awaitIsolate({
      isolate: child,
      signal: options.signal,
      timeoutMs: this._timeout(limits),
      send: () => child.send({ filePath, metadata, limits }),
      stop: () => {
        child.kill('SIGKILL');
        return Promise.resolve();
      },
      exitEvent: 'exit',
      errorEvent: 'error',
      exitCode: (code, signal) => ({ code, signal }),
      label: 'PDF extraction child',
      exitCodeName: 'PDF_CHILD_EXIT',
      // The child destroys PDF.js, flushes IPC, disconnects, and exits itself.
      // SIGKILL is reserved for abort/timeout/error containment.
      stopOnMessage: false,
    });
  }

  _awaitIsolate(config) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stopping = false;
      let timer;
      const signal = config.signal;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const stopAndReject = (error) => {
        if (settled) return;
        stopping = true;
        Promise.resolve().then(config.stop).catch(() => {}).finally(() => finish(reject, error));
      };
      const onAbort = () => stopAndReject(this._abortError());
      signal?.addEventListener('abort', onAbort, { once: true });

      config.isolate.once('message', (message) => {
        if (config.stopOnMessage !== false) {
          stopping = true;
          Promise.resolve().then(config.stop).catch(() => {});
        }
        if (message?.ok) {
          finish(resolve, Object.freeze({
            ...message.result,
            metadata: Object.freeze({ ...(message.result?.metadata || {}) }),
          }));
          return;
        }
        const details = message?.error || {};
        finish(reject, new AttachmentExtractionError(
          details.code || 'EXTRACTION_FAILED',
          details.message || 'Attachment extraction failed',
          { retryable: details.retryable === true }
        ));
      });
      config.isolate.once(config.errorEvent, (error) => {
        const wrapped = new AttachmentExtractionError(
          error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'PARSER_MEMORY_LIMIT' : config.exitCodeName,
          `${config.label} error: ${String(error?.message || error).slice(0, 1000)}`,
          { retryable: true }
        );
        finish(reject, wrapped);
      });
      config.isolate.once(config.exitEvent, (...values) => {
        if (settled || stopping) return;
        const detail = config.exitCode(...values);
        finish(reject, new AttachmentExtractionError(
          config.exitCodeName,
          `${config.label} exited before returning a result (${JSON.stringify(detail)})`,
          { retryable: true }
        ));
      });
      timer = setTimeout(() => {
        const error = new AttachmentExtractionError(
          'PARSER_TIMEOUT',
          `${config.label} exceeded ${config.timeoutMs}ms`,
          { retryable: true }
        );
        stopAndReject(error);
      }, config.timeoutMs);
      timer.unref?.();
      try { config.send(); } catch (error) { stopAndReject(error); }
    });
  }

  _memoryLimit(limits) {
    const value = limits.parserMaxOldSpaceMb ?? 128;
    if (!Number.isSafeInteger(value) || value < 16 || value > 2048) {
      throw new TypeError('parserMaxOldSpaceMb must be an integer from 16 to 2048');
    }
    return value;
  }

  _timeout(limits) {
    const value = limits.processingTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('processingTimeoutMs must be a positive safe integer');
    }
    return value;
  }

  _abortError() {
    const error = new AttachmentExtractionError(
      'PROCESSING_TIMEOUT',
      'Attachment extraction was aborted',
      { retryable: true }
    );
    error.name = 'AbortError';
    return error;
  }
}

module.exports = { AttachmentExtractionProcessor };
