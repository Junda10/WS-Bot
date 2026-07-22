'use strict';

const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_COMPLETED_LIMIT = 10_000;

class SmartReplySchedulerStoppedError extends Error {
  constructor(message = 'Smart-reply scheduler is stopping') {
    super(message);
    this.name = 'SmartReplySchedulerStoppedError';
    this.code = 'SMART_REPLY_SCHEDULER_STOPPED';
  }
}

function safeInteger(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer >= ${min}`);
  }
  return value;
}

/**
 * Debounces smart replies without detaching their lifecycle from message routing.
 * Every scheduled inbound message gets its own promise. Messages sharing a key
 * are processed in one batch and all of that batch's waiters settle together.
 */
class DebouncedSmartReplyScheduler {
  constructor(options = {}) {
    if (typeof options.process !== 'function') {
      throw new TypeError('DebouncedSmartReplyScheduler requires a process callback');
    }
    this.process = options.process;
    this.debounceMs = safeInteger(
      options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      'debounceMs'
    );
    this.completedLimit = safeInteger(
      options.completedLimit ?? DEFAULT_COMPLETED_LIMIT,
      'completedLimit',
      { min: 1 }
    );
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.logger = options.logger || console;
    this.accepting = true;
    this.states = new Map();
    this.completed = new Map();
    this.idleWaiters = new Set();
  }

  _state(key) {
    let state = this.states.get(key);
    if (!state) {
      state = { key, pending: [], timer: null, running: false };
      this.states.set(key, state);
    }
    return state;
  }

  _rememberCompleted(items, value) {
    for (const item of items) {
      this.completed.delete(item.id);
      this.completed.set(item.id, value);
    }
    while (this.completed.size > this.completedLimit) {
      this.completed.delete(this.completed.keys().next().value);
    }
  }

  _arm(state) {
    if (state.running || state.pending.length === 0) return;
    if (state.timer) this.clearTimer(state.timer);
    state.timer = this.setTimer(() => {
      state.timer = null;
      this._run(state).catch((error) => {
        // _run settles route waiters itself; this catch is only a final guard for
        // scheduler implementation errors, not a way to swallow route failures.
        this.logger.error?.(`Smart-reply scheduler error: ${error.message}`);
      });
    }, this.debounceMs);
    state.timer.unref?.();
  }

  async _run(state) {
    if (state.running || state.pending.length === 0) return;
    state.running = true;
    const batch = state.pending.splice(0);
    const last = batch.at(-1).item;
    const items = batch.map((entry) => entry.item);

    try {
      const value = await this.process(Object.freeze({
        key: state.key,
        items: Object.freeze(items),
        message: last.message,
        userId: last.userId,
        body: items.map((item) => item.body).join('\n'),
      }));
      this._rememberCompleted(items, value);
      for (const entry of batch) entry.resolve(value);
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    } finally {
      state.running = false;
      if (state.pending.length > 0) {
        this._arm(state);
      } else {
        this.states.delete(state.key);
      }
      this._notifyIdle();
    }
  }

  schedule(input = {}) {
    const id = String(input.id || '').trim();
    const key = String(input.key || '').trim();
    if (!id) throw new TypeError('Scheduled smart reply requires a stable message id');
    if (!key) throw new TypeError('Scheduled smart reply requires a chat/user key');
    if (typeof input.body !== 'string') throw new TypeError('Scheduled smart reply body must be a string');
    if (!input.message) throw new TypeError('Scheduled smart reply requires a message');
    if (!this.accepting) return Promise.reject(new SmartReplySchedulerStoppedError());
    if (this.completed.has(id)) return Promise.resolve(this.completed.get(id));

    const state = this._state(key);
    const promise = new Promise((resolve, reject) => {
      state.pending.push({
        item: Object.freeze({
          id,
          key,
          body: input.body,
          message: input.message,
          userId: String(input.userId || ''),
          persisted: input.persisted || null,
        }),
        resolve,
        reject,
      });
    });
    if (!state.running) this._arm(state);
    return promise;
  }

  stopAccepting() {
    this.accepting = false;
    return this.pendingCount();
  }

  isAccepting() {
    return this.accepting;
  }

  pendingCount() {
    let count = 0;
    for (const state of this.states.values()) count += state.pending.length;
    return count;
  }

  runningCount() {
    let count = 0;
    for (const state of this.states.values()) if (state.running) count += 1;
    return count;
  }

  cancelPending(error = new SmartReplySchedulerStoppedError()) {
    const reason = error instanceof Error ? error : new SmartReplySchedulerStoppedError(String(error));
    let cancelled = 0;
    for (const [key, state] of this.states) {
      if (state.timer) {
        this.clearTimer(state.timer);
        state.timer = null;
      }
      const pending = state.pending.splice(0);
      cancelled += pending.length;
      for (const entry of pending) entry.reject(reason);
      if (!state.running) this.states.delete(key);
    }
    this._notifyIdle();
    return cancelled;
  }

  _isIdle() {
    return this.states.size === 0;
  }

  _notifyIdle() {
    if (!this._isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  async drain({ timeoutMs = null } = {}) {
    if (timeoutMs !== null) safeInteger(timeoutMs, 'timeoutMs');
    if (this._isIdle()) return { drained: true, timedOut: false, remaining: 0 };

    let idleResolve;
    const idle = new Promise((resolve) => { idleResolve = resolve; });
    this.idleWaiters.add(idleResolve);
    if (timeoutMs === null) {
      await idle;
      return { drained: true, timedOut: false, remaining: 0 };
    }

    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.setTimer(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([idle.then(() => 'idle'), timeout]);
    this.clearTimer(timer);
    if (result === 'timeout') this.idleWaiters.delete(idleResolve);
    return {
      drained: result === 'idle',
      timedOut: result === 'timeout',
      remaining: this.pendingCount() + this.runningCount(),
    };
  }
}

function createDebouncedSmartReplyScheduler(options) {
  return new DebouncedSmartReplyScheduler(options);
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  DebouncedSmartReplyScheduler,
  SmartReplySchedulerStoppedError,
  createDebouncedSmartReplyScheduler,
};
