'use strict';

class MaintenanceScheduler {
  constructor({
    cron,
    retention,
    backup,
    expression = '30 2 * * *',
    timezone = 'Asia/Kuala_Lumpur',
    logger = console,
  } = {}) {
    if (!cron?.schedule || (cron.validate && !cron.validate(expression))) {
      throw new TypeError('A valid maintenance cron expression is required');
    }
    if (!retention?.run || !retention?.drain || !backup?.run || !backup?.drain) {
      throw new TypeError('MaintenanceScheduler requires cleanup and backup services');
    }
    this.cron = cron;
    this.retention = retention;
    this.backup = backup;
    this.expression = expression;
    this.timezone = timezone;
    this.logger = logger;
    this.task = null;
    this.active = null;
    this.registered = false;
    this.stopped = false;
    this.stopPromise = null;
  }

  start() {
    if (this.registered || this.stopped) return this;
    this.registered = true;
    this.task = this.cron.schedule(this.expression, () => Promise.resolve()
      .then(() => this.run())
      .catch((error) => {
        // Promise.resolve().then also captures a synchronous run() throw. No
        // tight retry loop: the next cron occurrence retries the full sequence.
        this.logger.error?.(`Scheduled maintenance failed; retrying next schedule: ${error.message}`);
      }), { timezone: this.timezone, noOverlap: true });
    this.logger.log?.(`Registered maintenance ${this.expression} (${this.timezone})`);
    return this;
  }

  run() {
    if (this.stopped) return Promise.resolve({ status: 'STOPPED' });
    if (this.active) return this.active;
    const operation = (async () => {
      const cleanup = await this.retention.run();
      const backup = await this.backup.run();
      return { status: 'SUCCEEDED', cleanup, backup };
    })();
    this.active = operation.finally(() => { this.active = null; });
    return this.active;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.backup.stop?.();
    this.retention.stop?.();
    const active = this.active;
    this.stopPromise = (async () => {
      try {
        await this.task?.stop?.();
      } catch (error) {
        this.logger.warn?.(`Maintenance cron shutdown failed: ${error.message}`);
      }
      // A cron implementation may stop asynchronously. Do not report shutdown
      // complete until both callback admission and an accepted run are finished.
      if (active) await active;
      return { stopped: true };
    })();
    return this.stopPromise;
  }

  async drain() {
    if (this.active) await this.active;
    await Promise.all([this.retention.drain(), this.backup.drain()]);
    return { drained: true };
  }
}

module.exports = { MaintenanceScheduler };
