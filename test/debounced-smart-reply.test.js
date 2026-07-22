'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SmartReplySchedulerStoppedError,
  createDebouncedSmartReplyScheduler,
} = require('../services/debounced-smart-reply');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function scheduled(id, body, extra = {}) {
  return {
    id,
    key: 'chat\u0000user',
    body,
    message: extra.message || { id },
    userId: 'user',
    persisted: extra.persisted || null,
  };
}

test('coalesced smart replies process once and settle every route waiter with the same result', async () => {
  const started = deferred();
  const release = deferred();
  const calls = [];
  const receipt = Object.freeze({ sent: true });
  const scheduler = createDebouncedSmartReplyScheduler({
    debounceMs: 1,
    process: async (batch) => {
      calls.push(batch);
      started.resolve();
      await release.promise;
      return receipt;
    },
  });

  let firstSettled = false;
  let secondSettled = false;
  const first = scheduler.schedule(scheduled('message-1', 'first')).then((value) => {
    firstSettled = true;
    return value;
  });
  const secondMessage = { id: 'last-message' };
  const second = scheduler.schedule(scheduled('message-2', 'second', {
    message: secondMessage,
    persisted: { id: 2 },
  })).then((value) => {
    secondSettled = true;
    return value;
  });

  await started.promise;
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, 'first\nsecond');
  assert.equal(calls[0].message, secondMessage);
  assert.deepEqual(calls[0].items.map((item) => item.id), ['message-1', 'message-2']);
  assert.deepEqual(calls[0].items[1].persisted, { id: 2 });

  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [receipt, receipt]);
  assert.deepEqual(await scheduler.drain(), {
    drained: true, timedOut: false, remaining: 0,
  });
});

test('coalesced processing errors reject every waiter and failed ids can be scheduled again', async () => {
  let attempts = 0;
  const scheduler = createDebouncedSmartReplyScheduler({
    debounceMs: 0,
    process: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary AI/send failure');
      return 'sent-on-retry';
    },
  });

  const first = scheduler.schedule(scheduled('retry-1', 'first'));
  const second = scheduler.schedule(scheduled('retry-2', 'second'));
  await assert.rejects(Promise.all([first, second]), /temporary AI\/send failure/);
  await assert.rejects(first, /temporary AI\/send failure/);
  await assert.rejects(second, /temporary AI\/send failure/);

  assert.equal(await scheduler.schedule(scheduled('retry-1', 'first retry')), 'sent-on-retry');
  assert.equal(attempts, 2);
});

test('drain waits for running work, while pending debounce can be cancelled without hanging', async () => {
  const started = deferred();
  const release = deferred();
  const runningScheduler = createDebouncedSmartReplyScheduler({
    debounceMs: 0,
    process: async () => {
      started.resolve();
      await release.promise;
      return 'done';
    },
  });
  const running = runningScheduler.schedule(scheduled('running', 'running'));
  await started.promise;

  let drainSettled = false;
  const drain = runningScheduler.drain().then((result) => {
    drainSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainSettled, false, 'drain must retain background generation/send work');
  assert.deepEqual(await runningScheduler.drain({ timeoutMs: 1 }), {
    drained: false, timedOut: true, remaining: 1,
  }, 'bounded shutdown must report a stuck background operation instead of hanging');
  release.resolve();
  assert.equal(await running, 'done');
  assert.deepEqual(await drain, { drained: true, timedOut: false, remaining: 0 });

  const pendingScheduler = createDebouncedSmartReplyScheduler({
    debounceMs: 60_000,
    process: async () => assert.fail('cancelled debounce must not process'),
  });
  const pending = pendingScheduler.schedule(scheduled('pending', 'pending'));
  pendingScheduler.stopAccepting();
  assert.equal(pendingScheduler.cancelPending(), 1);
  await assert.rejects(pending, (error) => error instanceof SmartReplySchedulerStoppedError);
  assert.deepEqual(await pendingScheduler.drain({ timeoutMs: 10 }), {
    drained: true, timedOut: false, remaining: 0,
  });
  await assert.rejects(
    pendingScheduler.schedule(scheduled('too-late', 'too late')),
    (error) => error instanceof SmartReplySchedulerStoppedError
  );
});
