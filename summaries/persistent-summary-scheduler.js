'use strict';

const SUMMARY_CRON_SLOTS = Object.freeze([
  Object.freeze({ expression: '0 10 * * *', slot: '10:00' }),
  Object.freeze({ expression: '0 14 * * *', slot: '14:00' }),
  Object.freeze({ expression: '0 20 * * *', slot: '20:00' }),
]);

function positiveDelay(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new TypeError(`${name} must be an integer from 1 to 86400000`);
  }
  return value;
}

class PersistentSummaryScheduler {
  constructor({
    cron,
    runner,
    recovery,
    timezone = 'Asia/Kuala_Lumpur',
    logger = console,
    recoveryRetryMs = 30_000,
    recoveryIntervalMs = 60_000,
    maxRecoveryBackoffMs = 15 * 60_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!cron || typeof cron.schedule !== 'function') throw new TypeError('cron.schedule is required');
    if (!runner?.triggerSlot || !runner?.stop || !runner?.drain) {
      throw new TypeError('a persistent summary runner is required');
    }
    if (!recovery?.recover) throw new TypeError('summary recovery service is required');
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('setTimer and clearTimer must be functions');
    }
    this.cron = cron;
    this.runner = runner;
    this.recovery = recovery;
    this.timezone = timezone;
    this.logger = logger;
    this.recoveryRetryMs = positiveDelay(recoveryRetryMs, 'recoveryRetryMs');
    this.recoveryIntervalMs = positiveDelay(recoveryIntervalMs, 'recoveryIntervalMs');
    this.maxRecoveryBackoffMs = positiveDelay(maxRecoveryBackoffMs, 'maxRecoveryBackoffMs');
    if (this.maxRecoveryBackoffMs < this.recoveryRetryMs) {
      throw new RangeError('maxRecoveryBackoffMs must be at least recoveryRetryMs');
    }
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.tasks = [];
    this.registered = false;
    this.startPromise = null;
    this.recoveryPromise = null;
    this.recoveryTimer = null;
    this.consecutiveRecoveryFailures = 0;
    this.stopped = false;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) return Promise.resolve({ status: 'STOPPED' });
    if (!this.registered) {
      this.registered = true;
      for (const definition of SUMMARY_CRON_SLOTS) {
        const task = this.cron.schedule(definition.expression, () => (
          this.runner.triggerSlot(definition.slot).catch((error) => {
            this.logger.error?.(`Scheduled summary ${definition.slot} failed: ${error.message}`);
          })
        ), { timezone: this.timezone, noOverlap: true });
        this.tasks.push(task);
      }
      this.logger.log?.(`Registered persistent summaries at 10:00, 14:00, 20:00 (${this.timezone})`);
    }
    this.startPromise = this._runRecovery();
    return this.startPromise;
  }

  _retryDelay() {
    const exponent = Math.max(0, this.consecutiveRecoveryFailures - 1);
    return Math.min(this.maxRecoveryBackoffMs, this.recoveryRetryMs * (2 ** Math.min(exponent, 30)));
  }

  _scheduleRecovery(delay) {
    if (this.stopped || this.recoveryTimer) return;
    this.recoveryTimer = this.setTimer(() => {
      this.recoveryTimer = null;
      return this._runRecovery().catch((error) => {
        this.logger.error?.(`Scheduled summary recovery timer failed: ${error.message}`);
      });
    }, delay);
    this.recoveryTimer?.unref?.();
  }

  _runRecovery() {
    if (this.stopped) return Promise.resolve({ status: 'STOPPED' });
    if (this.recoveryPromise) return this.recoveryPromise;
    const operation = (async () => {
      let result;
      try {
        result = await this.recovery.recover();
      } catch (error) {
        result = { status: 'FAILED', error };
        this.logger.error?.(`Scheduled summary recovery failed: ${error.message}`);
      }
      const healthy = ['RECOVERED', 'NOTHING_MISSING'].includes(result.status);
      if (healthy) this.consecutiveRecoveryFailures = 0;
      else this.consecutiveRecoveryFailures += 1;
      this._scheduleRecovery(healthy ? this.recoveryIntervalMs : this._retryDelay());
      return result;
    })();
    this.recoveryPromise = operation.finally(() => {
      this.recoveryPromise = null;
    });
    return this.recoveryPromise;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.recoveryTimer) {
      this.clearTimer(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    for (const task of this.tasks) {
      try { task.stop?.(); } catch (error) {
        this.logger.warn?.(`Failed to stop summary cron task: ${error.message}`);
      }
    }
    this.runner.stop();
  }

  drain(options) {
    return this.runner.drain(options);
  }
}

module.exports = { PersistentSummaryScheduler, SUMMARY_CRON_SLOTS };
