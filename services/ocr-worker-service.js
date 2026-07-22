'use strict';

const fs = require('fs');
const { createWorker: defaultCreateWorker, OEM } = require('tesseract.js');
const { AttachmentExtractionError } = require('./attachment-extractors');

const CANCELLED = Symbol('cancelled');

function abortError(message = 'OCR operation was aborted') {
  const error = new AttachmentExtractionError('OCR_ABORTED', message, { retryable: true });
  error.name = 'AbortError';
  return error;
}

function ocrError(code, message, error) {
  if (error instanceof AttachmentExtractionError) return error;
  return new AttachmentExtractionError(
    code,
    `${message}: ${String(error?.message || error)}`,
    { retryable: true }
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function bounded(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

class OcrWorkerService {
  constructor(options = {}) {
    this.createWorker = options.createWorker || defaultCreateWorker;
    this.languages = String(options.languages || 'eng+chi_sim').trim();
    this.cachePath = options.cachePath;
    this.langPath = options.langPath;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? this.timeoutMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? 1_000;
    this.logger = options.logger || { warn() {}, error() {} };
    if (!/^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/u.test(this.languages)) {
      throw new TypeError('OCR languages must be plus-separated Tesseract language codes');
    }
    for (const [name, value] of Object.entries({
      timeoutMs: this.timeoutMs,
      initializeTimeoutMs: this.initializeTimeoutMs,
      shutdownTimeoutMs: this.shutdownTimeoutMs,
      terminateTimeoutMs: this.terminateTimeoutMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`OCR ${name} must be a positive safe integer`);
      }
    }
    this.worker = null;
    this.initializing = null;
    this.terminating = null;
    this.generation = 0;
    this.invalidations = new WeakMap();
    this.activeInvalidations = new Set();
    this.requests = new Set();
    this.tail = Promise.resolve();
    this.closed = false;
  }

  initialize(options = {}) {
    if (this.closed) return Promise.reject(abortError('OCR service is terminated'));
    if (options.signal?.aborted) return Promise.reject(abortError('OCR initialization was aborted'));
    if (this.worker) return Promise.resolve(this.worker.instance);
    if (!this.initializing) this._startInitialization(options.timeoutMs ?? this.initializeTimeoutMs);
    const attempt = this.initializing;
    if (!options.signal) return attempt.promise;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => options.signal.removeEventListener('abort', onAbort);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onAbort = () => {
        const error = abortError('OCR initialization was aborted');
        this._cancelInitialization(attempt, error);
        finish(reject, error);
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      attempt.promise.then(
        (worker) => finish(resolve, worker),
        (error) => finish(reject, error)
      );
      if (options.signal.aborted) onAbort();
    });
  }

  _startInitialization(timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('OCR initialization timeout must be a positive safe integer');
    }
    if (this.cachePath) fs.mkdirSync(this.cachePath, { recursive: true, mode: 0o700 });
    const generation = ++this.generation;
    const completion = deferred();
    const attempt = {
      generation,
      state: 'active',
      worker: null,
      promise: completion.promise,
      resolve: completion.resolve,
      reject: completion.reject,
      timer: null,
    };
    this.initializing = attempt;

    const fail = (error) => this._cancelInitialization(attempt, error);
    const options = {
      cacheMethod: 'readOnly',
      gzip: true,
      logger: () => {},
      // Tesseract's default error handler throws from worker event callbacks.
      // Supplying this handler is mandatory so bad/missing traineddata becomes
      // a normal rejected OCR operation rather than an uncaught exception.
      errorHandler: (error) => {
        const wrapped = ocrError(
          attempt.state === 'active' ? 'OCR_INITIALIZATION_FAILED' : 'OCR_WORKER_FAILED',
          'Tesseract worker reported an error',
          error
        );
        if (attempt.state === 'active') fail(wrapped);
        else if (attempt.worker) {
          for (const request of this.requests) {
            if (request.worker === attempt.worker) this._cancelRequest(request, wrapped);
          }
          this._invalidate(attempt.worker);
        }
      },
    };
    if (this.cachePath) options.cachePath = this.cachePath;
    // A configured local langPath makes cache misses fail locally instead of
    // silently downloading traineddata from a CDN.
    if (this.langPath) options.langPath = this.langPath;

    attempt.timer = setTimeout(() => fail(new AttachmentExtractionError(
      'OCR_INITIALIZATION_TIMEOUT',
      `OCR worker initialization exceeded ${timeoutMs}ms`,
      { retryable: true }
    )), timeoutMs);
    attempt.timer.unref?.();

    Promise.resolve()
      .then(() => this.createWorker(this.languages, OEM.LSTM_ONLY, options))
      .then((worker) => {
        attempt.worker = worker;
        if (attempt.state !== 'active' || this.closed || generation !== this.generation) {
          this._terminateDetached(worker);
          return;
        }
        if (!worker || typeof worker.recognize !== 'function' || typeof worker.terminate !== 'function') {
          fail(new TypeError('Tesseract worker must provide recognize() and terminate()'));
          this._terminateDetached(worker);
          return;
        }
        clearTimeout(attempt.timer);
        attempt.state = 'succeeded';
        if (this.initializing === attempt) this.initializing = null;
        this.worker = { instance: worker, generation };
        attempt.resolve(worker);
      }, (error) => fail(ocrError(
        'OCR_INITIALIZATION_FAILED',
        'OCR worker initialization failed',
        error
      )))
      .catch((error) => {
        // Every createWorker continuation is consumed, including late failures.
        this.logger.warn?.(`Late OCR initialization cleanup failed: ${String(error?.message || error)}`);
      });
  }

  _cancelInitialization(attempt, error) {
    if (!attempt || attempt.state !== 'active') return;
    attempt.state = 'failed';
    clearTimeout(attempt.timer);
    if (this.initializing === attempt) this.initializing = null;
    if (attempt.generation === this.generation) this.generation += 1;
    attempt.reject(error instanceof AttachmentExtractionError
      ? error
      : ocrError('OCR_INITIALIZATION_FAILED', 'OCR worker initialization failed', error));
    if (attempt.worker) this._terminateDetached(attempt.worker);
  }

  recognize(image, options = {}) {
    if (this.closed) return Promise.reject(abortError('OCR service is terminated'));
    if (options.signal?.aborted) return Promise.reject(abortError());
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new TypeError('OCR recognize timeout must be a positive safe integer'));
    }

    const completion = deferred();
    const cancellation = deferred();
    const request = {
      active: true,
      completion,
      cancellation,
      deadline: Date.now() + timeoutMs,
      timeoutMs,
      signal: options.signal,
      onAbort: null,
      timer: null,
      worker: null,
      workerGeneration: null,
      recognizeOptions: options.recognizeOptions || {},
      image,
      waitingInitialization: false,
    };
    request.onAbort = () => this._cancelRequest(request, abortError());
    options.signal?.addEventListener('abort', request.onAbort, { once: true });
    request.timer = setTimeout(() => this._cancelRequest(request, new AttachmentExtractionError(
      'OCR_TIMEOUT',
      `OCR recognition exceeded ${timeoutMs}ms`,
      { retryable: true }
    )), timeoutMs);
    request.timer.unref?.();
    this.requests.add(request);

    const operation = this.tail.then(() => this._runRecognition(request));
    this.tail = operation.catch(() => {});
    return completion.promise;
  }

  async _runRecognition(request) {
    if (!request.active) return;
    request.waitingInitialization = true;
    let initialized;
    try {
      initialized = await Promise.race([
        this.initialize(),
        request.cancellation.promise,
      ]);
    } catch (error) {
      this._rejectRequest(request, error instanceof AttachmentExtractionError
        ? error
        : ocrError('OCR_INITIALIZATION_FAILED', 'OCR worker initialization failed', error));
      return;
    } finally {
      request.waitingInitialization = false;
    }
    if (initialized === CANCELLED || !request.active) return;
    if (Date.now() >= request.deadline) {
      this._cancelRequest(request, new AttachmentExtractionError(
        'OCR_TIMEOUT',
        `OCR recognition exceeded ${request.timeoutMs}ms`,
        { retryable: true }
      ));
      return;
    }

    const record = this.worker;
    if (!record || record.instance !== initialized) {
      this._rejectRequest(request, new AttachmentExtractionError(
        'OCR_WORKER_QUARANTINED',
        'OCR worker generation changed before recognition',
        { retryable: true }
      ));
      return;
    }
    request.worker = initialized;
    request.workerGeneration = record.generation;
    const recognition = Promise.resolve()
      .then(() => initialized.recognize(
        request.image,
        request.recognizeOptions,
        { text: true }
      ))
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      );
    // A late result is deliberately observed but can never settle the caller.
    recognition.then(() => {
      if (!request.active) this._invalidate(initialized);
    }).catch(() => {});

    const outcome = await Promise.race([recognition, request.cancellation.promise]);
    if (outcome === CANCELLED || !request.active) return;
    if (Date.now() >= request.deadline
        || this.worker?.instance !== initialized
        || this.worker?.generation !== request.workerGeneration) {
      this._cancelRequest(request, new AttachmentExtractionError(
        'OCR_TIMEOUT',
        `OCR recognition exceeded ${request.timeoutMs}ms or used a stale worker`,
        { retryable: true }
      ));
      return;
    }
    if (!outcome.ok) {
      this._invalidate(initialized);
      this._rejectRequest(request, ocrError('OCR_WORKER_FAILED', 'OCR worker failed', outcome.error));
      return;
    }
    this._resolveRequest(request, outcome.value);
  }

  _cleanupRequest(request) {
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.onAbort);
    this.requests.delete(request);
  }

  _resolveRequest(request, value) {
    if (!request.active) return;
    request.active = false;
    this._cleanupRequest(request);
    request.completion.resolve(value);
  }

  _rejectRequest(request, error) {
    if (!request.active) return;
    request.active = false;
    this._cleanupRequest(request);
    request.cancellation.resolve(CANCELLED);
    request.completion.reject(error);
  }

  _cancelRequest(request, error) {
    if (!request.active) return;
    const worker = request.worker;
    const waitingInitialization = request.waitingInitialization;
    this._rejectRequest(request, error);
    // State is invalidated synchronously; potentially hanging termination is
    // always detached and bounded.
    if (worker) this._invalidate(worker);
    else if (waitingInitialization && this.initializing) {
      this._cancelInitialization(this.initializing, error);
    }
  }

  _invalidate(worker) {
    if (!worker) return Promise.resolve();
    if (this.worker?.instance === worker) {
      this.worker = null;
      this.generation += 1;
    }
    return this._terminateDetached(worker);
  }

  _terminateDetached(worker) {
    if (!worker || typeof worker.terminate !== 'function') return Promise.resolve();
    if (this.invalidations.has(worker)) return this.invalidations.get(worker);
    let termination;
    try {
      termination = Promise.resolve(worker.terminate());
    } catch (error) {
      termination = Promise.reject(error);
    }
    const observed = termination.catch((error) => {
      this.logger.warn?.(`OCR worker termination failed: ${String(error?.message || error)}`);
    });
    const invalidation = bounded(observed, this.terminateTimeoutMs).then((finished) => {
      if (!finished) this.logger.warn?.(`OCR worker termination exceeded ${this.terminateTimeoutMs}ms`);
    });
    this.invalidations.set(worker, invalidation);
    this.activeInvalidations.add(invalidation);
    invalidation.finally(() => this.activeInvalidations.delete(invalidation)).catch(() => {});
    return invalidation;
  }

  terminate() {
    if (this.terminating) return this.terminating;
    this.closed = true;
    const error = abortError('OCR service is terminating');
    for (const request of [...this.requests]) this._cancelRequest(request, error);
    if (this.initializing) this._cancelInitialization(this.initializing, error);
    if (this.worker) this._invalidate(this.worker.instance);
    // Never await createWorker, recognize(), the serial tail, or an unbounded
    // worker.terminate(). Shutdown has its own hard upper bound.
    const shutdown = Promise.allSettled([...this.activeInvalidations]);
    this.terminating = bounded(shutdown, this.shutdownTimeoutMs).then(() => undefined);
    return this.terminating;
  }
}

module.exports = { OcrWorkerService, abortError };
