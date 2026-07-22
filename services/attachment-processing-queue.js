'use strict';

class QueueStoppedError extends Error {
  constructor() {
    super('Attachment processing queue is not accepting work');
    this.name = 'QueueStoppedError';
    this.code = 'QUEUE_STOPPED';
    this.retryable = true;
  }
}

class QueueFullError extends Error {
  constructor(limit) {
    super(`Attachment processing queue reached its ${limit}-job pending limit`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
    this.retryable = true;
  }
}

class AttachmentProcessingQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32) {
      throw new TypeError('Attachment queue concurrency must be an integer from 1 to 32');
    }
    this.maxPending = options.maxPending ?? 100;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 100_000) {
      throw new TypeError('Attachment queue maxPending must be an integer from 1 to 100000');
    }
    this.pending = [];
    this.active = 0;
    this.accepting = true;
    this.drainWaiters = new Set();
  }

  enqueue(work, metadata = {}) {
    if (typeof work !== 'function') throw new TypeError('Queued attachment work must be a function');
    if (!this.accepting) throw new QueueStoppedError();
    if (this.pending.length >= this.maxPending) throw new QueueFullError(this.maxPending);
    const promise = new Promise((resolve, reject) => {
      this.pending.push({ work, metadata: Object.freeze({ ...metadata }), resolve, reject });
    });
    // Never execute user work in the message-handler call stack.
    setImmediate(() => this._pump());
    return promise;
  }

  _pump() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(() => job.work(job.metadata))
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this._settleDrain();
          this._pump();
        });
    }
    this._settleDrain();
  }

  _settleDrain() {
    if (this.active !== 0 || this.pending.length !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  stopAccepting() {
    this.accepting = false;
    return { active: this.active, pending: this.pending.length };
  }

  async drain(options = {}) {
    const timeoutMs = options.timeoutMs ?? null;
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
      throw new TypeError('queue drain timeoutMs must be null or a non-negative safe integer');
    }
    if (this.active === 0 && this.pending.length === 0) {
      return { drained: true, timedOut: false, active: 0, pending: 0 };
    }
    let timer;
    const drained = new Promise((resolve) => this.drainWaiters.add(resolve));
    const outcome = timeoutMs === null
      ? (await drained, 'drained')
      : await Promise.race([
        drained.then(() => 'drained'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
          timer.unref?.();
        }),
      ]);
    if (timer) clearTimeout(timer);
    return {
      drained: outcome === 'drained',
      timedOut: outcome === 'timeout',
      active: this.active,
      pending: this.pending.length,
    };
  }

  get size() {
    return this.pending.length;
  }
}

module.exports = {
  AttachmentProcessingQueue,
  QueueFullError,
  QueueStoppedError,
};
