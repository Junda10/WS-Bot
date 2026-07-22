'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { PersistentSummaryRunner, reportMarker } = require('../summaries/persistent-summary-runner');
const { PersistentSummaryScheduler } = require('../summaries/persistent-summary-scheduler');
const { ScheduledSummaryService } = require('../summaries/scheduled-summary-service');
const { SummaryRecoveryService, expectedWindows } = require('../summaries/summary-recovery-service');
const { scheduledReportWindow } = require('../summaries/window');

const KL = 'Asia/Kuala_Lumpur';
const JID = '120300000000000000@g.us';
const utc = (iso) => DateTime.fromISO(iso, { zone: 'UTC' }).toMillis();

function fixture(t, initialNow = utc('2026-07-22T07:00:00Z')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-scheduled-summary-'));
  const db = getDatabase({ filename: path.join(root, 'test.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({ jid: JID, timezone: KL, now: 2 }).record;
  const state = { now: initialNow };
  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, repositories, chat, state, clock: () => state.now };
}

function descriptor(slot, localDate = '2026-07-22') {
  const window = scheduledReportWindow({ slot, localDate, timezone: KL });
  return {
    ...window,
    reportType: `AUTO_${window.slot.slice(0, 2)}`,
    windowStart: window.startUtcMs,
    windowEnd: window.endUtcMs,
    scheduledFor: window.scheduledForUtcMs,
  };
}

function fakeSummary(parts = ['summary']) {
  const calls = [];
  return {
    calls,
    async build(input) {
      calls.push(input);
      return { parts: parts.map((part) => String(part)) };
    },
  };
}

function fakeAdapter(options = {}) {
  const outgoing = [];
  let sends = 0;
  return {
    outgoing,
    get sends() { return sends; },
    async sendText(chatJid, content) {
      sends += 1;
      const receipt = { id: `wa-${sends}`, sentAt: null, chatJid, content };
      outgoing.push(receipt);
      if (options.crashAfterSendOnce && sends === 1) throw new Error('simulated crash after transport send');
      if (options.failOnSend?.has(sends)) throw new Error(`send ${sends} failed`);
      if (options.blockSend) await options.blockSend.promise;
      return receipt;
    },
    async findRecentOutgoingByMarker(_chatJid, marker) {
      if (options.lookupAvailable === false) {
        return { available: false, receipt: null, reason: 'fake unavailable' };
      }
      const found = [...outgoing].reverse().find((item) => item.content.includes(marker));
      return { available: true, receipt: found ? { id: found.id, sentAt: found.sentAt } : null };
    },
  };
}

function runner(ctx, summaryService, adapter, options = {}) {
  return new PersistentSummaryRunner({
    repositories: ctx.repositories,
    summaryService,
    adapter,
    chat: ctx.chat,
    timezone: KL,
    clock: ctx.clock,
    logger: options.logger || { log() {}, warn() {}, error() {} },
    leaseMs: options.leaseMs ?? 100,
    sendLeaseMs: options.sendLeaseMs ?? 50,
    maxAttemptsPerInvocation: options.maxAttempts ?? 1,
    backoffMs: [1, 2],
    wait: async (ms) => { ctx.state.now += ms; return true; },
  });
}

function completeWindow(ctx, window, suffix) {
  const claimed = ctx.repositories.summaries.claim({
    runUid: `covered-${suffix}`,
    chatId: ctx.chat.id,
    reportType: window.reportType,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    scheduledFor: window.scheduledFor,
    now: ctx.state.now,
  }).record;
  const part = ctx.repositories.summaries.addPart({
    partUid: `covered-part-${suffix}`, runId: claimed.id, partIndex: 0,
    content: `covered ${suffix}`, now: ctx.state.now,
  }).record;
  ctx.repositories.summaries.seal(claimed.id, ctx.state.now);
  ctx.repositories.summaries.markPartSent({
    partId: part.id, whatsappMessageId: `covered-wa-${suffix}`, now: ctx.state.now,
  });
  ctx.repositories.summaries.complete(claimed.id, ctx.state.now);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeTimers() {
  const pending = new Set();
  const delays = [];
  return {
    pending,
    delays,
    setTimer(callback, delay) {
      const handle = { callback, delay, unref() {} };
      delays.push(delay);
      pending.add(handle);
      return handle;
    },
    clearTimer(handle) { pending.delete(handle); },
    async fireNext() {
      const handle = pending.values().next().value;
      assert.ok(handle, 'expected one pending timer');
      pending.delete(handle);
      await handle.callback();
    },
  };
}

function evidenceConversation(records) {
  const calls = [];
  return {
    calls,
    async build(input) {
      calls.push(input);
      const selected = records.filter((record) => (
        record.sentAt >= input.window.startUtcMs && record.sentAt < input.window.endUtcMs
      ));
      return {
        records: selected.map((record, index) => ({
          sourceType: 'CHAT', content: record.content, sentAt: record.sentAt,
          stableId: index + 1, provenance: `evidence-${index + 1}`,
        })),
        attachmentGaps: [],
        stats: { chatMessageCount: selected.length, parsedMarkdownCount: 0 },
        ai: {
          ok: true,
          value: {
            discussionPoints: selected.map((record) => record.content),
            decisions: [], todos: [], uncertainties: [],
          },
          errorCode: null, modelCalls: 1, omittedChunkCount: 0,
        },
      };
    },
  };
}

test('registers exactly three noOverlap Kuala Lumpur cron tasks once across reconnect ready events', async () => {
  const registrations = [];
  const tasks = [];
  const cron = {
    schedule(expression, callback, options) {
      const task = { stopped: 0, stop() { this.stopped += 1; } };
      registrations.push({ expression, callback, options });
      tasks.push(task);
      return task;
    },
  };
  const runnerStub = {
    async triggerSlot() {}, stop() {}, async drain() { return { timedOut: false, remaining: 0 }; },
  };
  let recoveries = 0;
  const scheduler = new PersistentSummaryScheduler({
    cron,
    runner: runnerStub,
    recovery: { async recover() { recoveries += 1; return { status: 'NOTHING_MISSING' }; } },
    timezone: KL,
    logger: { log() {}, warn() {}, error() {} },
  });
  await Promise.all([scheduler.start(), scheduler.start(), scheduler.start()]);
  assert.deepEqual(registrations.map((entry) => entry.expression), [
    '0 10 * * *', '0 14 * * *', '0 20 * * *',
  ]);
  assert.ok(registrations.every((entry) => entry.options.timezone === KL
    && entry.options.noOverlap === true));
  assert.equal(recoveries, 1);
  scheduler.stop();
  scheduler.stop();
  assert.ok(tasks.every((task) => task.stopped === 1));
});

test('duplicate slot triggers atomically claim once and invoke AI/summary once', async (t) => {
  const ctx = fixture(t);
  const gate = deferred();
  const summary = fakeSummary();
  const originalBuild = summary.build.bind(summary);
  summary.build = async (input) => { await gate.promise; return originalBuild(input); };
  const adapter = fakeAdapter();
  const service = runner(ctx, summary, adapter);
  const first = service.triggerSlot('14:00', { localDate: '2026-07-22' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await service.triggerSlot('14:00', { localDate: '2026-07-22' });
  assert.equal(second.status, 'BUSY');
  gate.resolve();
  assert.equal((await first).status, 'SUCCEEDED');
  assert.equal(summary.calls.length, 1);
  assert.equal(adapter.sends, 1);
  assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM summary_runs').get().n, 1);
});

test('sealed manifest and hashes stay stable; partial failure retries only pending part without repeated AI', async (t) => {
  const ctx = fixture(t);
  const summary = fakeSummary(['first part', 'second part']);
  const adapter = fakeAdapter({ failOnSend: new Set([2]) });
  const firstRunner = runner(ctx, summary, adapter, { maxAttempts: 1 });
  const failed = await firstRunner.triggerSlot('14:00', { localDate: '2026-07-22' });
  assert.equal(failed.status, 'FAILED');
  const run = ctx.db.prepare('SELECT * FROM summary_runs').get();
  const before = ctx.repositories.summaries.listParts(run.id)
    .map((part) => ({ content: part.content, hash: part.content_hash, status: part.status }));
  assert.deepEqual(before.map((part) => part.status), ['SENT', 'FAILED']);
  assert.ok(run.manifest_sealed_at !== null);

  const restarted = runner(ctx, summary, adapter, { maxAttempts: 1 });
  const succeeded = await restarted.triggerSlot('14:00', { localDate: '2026-07-22' });
  assert.equal(succeeded.status, 'SUCCEEDED');
  const after = ctx.repositories.summaries.listParts(run.id);
  assert.deepEqual(after.map((part) => ({ content: part.content, hash: part.content_hash })),
    before.map((part) => ({ content: part.content, hash: part.hash })));
  assert.equal(summary.calls.length, 1, 'sealed retries must not invoke AI/build again');
  assert.equal(adapter.outgoing.filter((item) => item.content.includes('first part')).length, 1);
  assert.equal(after[1].attempt_count, 2);
  assert.ok(after.every((part) => part.status === 'SENT' && part.whatsapp_message_id));
});

test('send-success before DB acknowledgement is recovered by deterministic marker lookup without duplicate', async (t) => {
  const ctx = fixture(t);
  const summary = fakeSummary(['crash-safe']);
  const adapter = fakeAdapter({ crashAfterSendOnce: true });
  const firstRunner = runner(ctx, summary, adapter, { maxAttempts: 1 });
  assert.equal((await firstRunner.triggerSlot('20:00', { localDate: '2026-07-22' })).status, 'FAILED');
  assert.equal(adapter.outgoing.length, 1);
  const run = ctx.db.prepare('SELECT * FROM summary_runs').get();
  assert.ok(adapter.outgoing[0].content.includes(reportMarker(run, 0)));

  const restarted = runner(ctx, summary, adapter, { maxAttempts: 1 });
  assert.equal((await restarted.triggerSlot('20:00', { localDate: '2026-07-22' })).status, 'SUCCEEDED');
  assert.equal(adapter.outgoing.length, 1, 'marker match acknowledges instead of resending');
  assert.equal(ctx.repositories.summaries.listParts(run.id)[0].whatsapp_message_id, 'wa-1');
  assert.equal(summary.calls.length, 1);
});

test('normal send acknowledgement invariant mismatch fails fast, rolls back part, and retries without duplicate send', async (t) => {
  const ctx = fixture(t);
  const summary = fakeSummary(['ack-normal']);
  const adapter = fakeAdapter();
  const original = ctx.repositories.summaries.markPartSent.bind(ctx.repositories.summaries);
  let rejectAcknowledgement = true;
  ctx.repositories.summaries.markPartSent = (input) => {
    if (rejectAcknowledgement) {
      rejectAcknowledgement = false;
      return null;
    }
    return original(input);
  };
  const service = runner(ctx, summary, adapter, { maxAttempts: 1 });
  const failed = await service.triggerSlot('14:00', { localDate: '2026-07-22' });
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error.message, /acknowledgement invariant mismatch/u);
  const run = ctx.db.prepare('SELECT * FROM summary_runs').get();
  assert.equal(ctx.repositories.summaries.listParts(run.id)[0].status, 'FAILED');

  const retried = await service.triggerSlot('14:00', { localDate: '2026-07-22' });
  assert.equal(retried.status, 'SUCCEEDED');
  assert.equal(adapter.outgoing.length, 1, 'marker recovery must not duplicate the successful transport send');
  assert.equal(ctx.repositories.summaries.listParts(run.id)[0].status, 'SENT');
});

test('marker recovery acknowledgement invariant mismatch also rolls back and remains retryable', async (t) => {
  const ctx = fixture(t);
  const summary = fakeSummary(['ack-marker']);
  const adapter = fakeAdapter({ crashAfterSendOnce: true });
  const service = runner(ctx, summary, adapter, { maxAttempts: 1 });
  assert.equal((await service.triggerSlot('20:00', { localDate: '2026-07-22' })).status, 'FAILED');

  const original = ctx.repositories.summaries.markPartSent.bind(ctx.repositories.summaries);
  ctx.repositories.summaries.markPartSent = () => null;
  const invariantFailure = await service.triggerSlot('20:00', { localDate: '2026-07-22' });
  assert.equal(invariantFailure.status, 'FAILED');
  assert.match(invariantFailure.error.message, /acknowledgement invariant mismatch/u);
  const run = ctx.db.prepare('SELECT * FROM summary_runs').get();
  assert.equal(ctx.repositories.summaries.listParts(run.id)[0].status, 'FAILED');

  ctx.repositories.summaries.markPartSent = original;
  assert.equal((await service.triggerSlot('20:00', { localDate: '2026-07-22' })).status, 'SUCCEEDED');
  assert.equal(adapter.outgoing.length, 1);
});

test('expired RUNNING and SENDING leases reclaim after restart without rebuilding manifest', async (t) => {
  const ctx = fixture(t);
  const window = descriptor('14:00');
  const claimed = ctx.repositories.summaries.claim({
    chatId: ctx.chat.id, reportType: window.reportType,
    windowStart: window.windowStart, windowEnd: window.windowEnd,
    scheduledFor: window.scheduledFor, now: ctx.state.now, leaseMs: 20,
  }).record;
  ctx.repositories.summaries.persistManifest(claimed.id, ['already sealed'], ctx.state.now);
  const part = ctx.repositories.summaries.listParts(claimed.id)[0];
  ctx.repositories.summaries.markPartSending(part.id, ctx.state.now, { leaseMs: 20 });
  ctx.state.now += 21;
  const summary = fakeSummary(['must not build']);
  const adapter = fakeAdapter({ lookupAvailable: false });
  const warnings = [];
  const restarted = runner(ctx, summary, adapter, {
    logger: { log() {}, warn(message) { warnings.push(message); }, error() {} },
  });
  assert.equal((await restarted.runWindow(window)).status, 'SUCCEEDED');
  assert.equal(summary.calls.length, 0);
  assert.equal(ctx.repositories.summaries.findById(claimed.id).attempt_count, 2);
  assert.equal(ctx.repositories.summaries.listParts(claimed.id)[0].attempt_count, 2);
  assert.ok(warnings.some((message) => /safe at-least-once fallback/u.test(message)));
});

test('startup recovery waits for adapter readiness and an enabled authorized chat without side effects', async (t) => {
  const ctx = fixture(t);
  const summary = fakeSummary();
  const adapter = fakeAdapter();
  const serviceRunner = runner(ctx, summary, adapter);
  let ready = false;
  const recovery = new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => ready,
    logger: { warn() {} },
  });
  assert.equal((await recovery.recover()).status, 'WAITING_FOR_ADAPTER');
  ready = true;
  ctx.repositories.chats.setEnabled(ctx.chat.id, false, ctx.state.now);
  assert.equal((await recovery.recover()).status, 'WAITING_FOR_AUTHORIZED_CHAT');
  assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM summary_runs').get().n, 0);
  assert.equal(adapter.sends, 0);
});

test('one missed window sends its original exact range labeled delayed and restart suppresses replay', async (t) => {
  const ctx = fixture(t);
  const expected = expectedWindows({ now: ctx.state.now, timezone: KL, recoveryHours: 24 });
  assert.ok(expected.length >= 3);
  const missed = expected[1];
  expected.forEach((window, index) => { if (window !== missed) completeWindow(ctx, window, index); });
  const summary = fakeSummary(['one delayed']);
  const adapter = fakeAdapter();
  const serviceRunner = runner(ctx, summary, adapter);
  const recovery = new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => true,
    logger: { warn() {} },
  });
  const result = await recovery.recover();
  assert.equal(result.status, 'RECOVERED');
  assert.equal(result.missing.length, 1);
  assert.equal(summary.calls[0].delayed, true);
  assert.equal(summary.calls[0].window.startUtcMs, missed.windowStart);
  assert.equal(summary.calls[0].window.endUtcMs, missed.windowEnd);
  assert.equal((await recovery.recover()).status, 'NOTHING_MISSING');
  assert.equal(adapter.sends, 1);
});

test('multiple missed windows send one combined delayed run and durable mappings suppress next restart', async (t) => {
  const ctx = fixture(t);
  const expected = expectedWindows({ now: ctx.state.now, timezone: KL, recoveryHours: 24 });
  const summary = fakeSummary(['combined delayed']);
  const adapter = fakeAdapter();
  const serviceRunner = runner(ctx, summary, adapter);
  const makeRecovery = () => new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => true,
    logger: { warn() {} },
  });
  const first = await makeRecovery().recover();
  assert.equal(first.status, 'RECOVERED');
  assert.ok(first.missing.length > 1);
  assert.equal(adapter.sends, 1);
  assert.equal(summary.calls.length, 1);
  assert.equal(summary.calls[0].constituentWindows.length, expected.length);
  const owners = ctx.db.prepare('SELECT DISTINCT run_id FROM summary_run_coverage').all();
  assert.equal(owners.length, 1);
  assert.equal(ctx.repositories.summaries.findById(owners[0].run_id).report_type, 'RECOVERY');
  assert.equal((await makeRecovery().recover()).status, 'NOTHING_MISSING');
  assert.equal(adapter.sends, 1);
});

test('non-contiguous 10:00 and 20:00 misses exclude the successful 14:00 gap and stay covered after restart', async (t) => {
  const ctx = fixture(t, utc('2026-07-22T13:00:00Z')); // 21:00 Kuala Lumpur
  const expected = expectedWindows({ now: ctx.state.now, timezone: KL, recoveryHours: 24 });
  assert.deepEqual(expected.map((window) => window.reportType), ['AUTO_10', 'AUTO_14', 'AUTO_20']);
  const ten = expected[0];
  const fourteen = expected[1];
  const twenty = expected[2];
  completeWindow(ctx, fourteen, 'successful-14');

  const conversation = evidenceConversation([
    { sentAt: ten.windowStart + 1000, content: 'MISSING TEN CONTENT' },
    { sentAt: fourteen.windowStart + 1000, content: 'SUCCESSFUL FOURTEEN CONTENT' },
    { sentAt: twenty.windowStart + 1000, content: 'MISSING TWENTY CONTENT' },
  ]);
  const summary = new ScheduledSummaryService({
    repositories: ctx.repositories,
    conversationService: conversation,
    timezone: KL,
    maxOutputLength: 3400,
  });
  const adapter = fakeAdapter();
  const serviceRunner = runner(ctx, summary, adapter);
  const makeRecovery = () => new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => true,
    logger: { warn() {} },
  });

  const recovered = await makeRecovery().recover();
  assert.equal(recovered.status, 'RECOVERED');
  assert.deepEqual(recovered.missing.map((item) => item.reportType), ['AUTO_10', 'AUTO_20']);
  assert.deepEqual(conversation.calls.map((call) => [call.window.startUtcMs, call.window.endUtcMs]), [
    [ten.windowStart, ten.windowEnd],
    [twenty.windowStart, twenty.windowEnd],
  ]);
  const sentText = adapter.outgoing.map((item) => item.content).join('\n');
  assert.match(sentText, /MISSING TEN CONTENT/u);
  assert.match(sentText, /MISSING TWENTY CONTENT/u);
  assert.doesNotMatch(sentText, /SUCCESSFUL FOURTEEN CONTENT/u);
  assert.equal((sentText.match(/\*全部等待 Tevau 回复/u) || []).length, 1,
    'the current open queue is emitted only once in a combined report');

  assert.equal((await makeRecovery().recover()).status, 'NOTHING_MISSING');
  assert.equal(adapter.outgoing.map((item) => item.content).join('\n'), sentText);
  assert.equal(ctx.db.prepare('SELECT count(DISTINCT run_id) AS n FROM summary_run_coverage').get().n, 2);
});

test('startup recovery discovers FAILED and expired RUNNING owners', async (t) => {
  const ctx = fixture(t, utc('2026-07-22T13:00:00Z'));
  const expected = expectedWindows({ now: ctx.state.now, timezone: KL, recoveryHours: 24 });
  const [failedWindow, successfulWindow, expiredWindow] = expected;
  completeWindow(ctx, successfulWindow, 'successful-middle');

  const failedRun = ctx.repositories.summaries.claim({
    chatId: ctx.chat.id, reportType: failedWindow.reportType,
    windowStart: failedWindow.windowStart, windowEnd: failedWindow.windowEnd,
    scheduledFor: failedWindow.scheduledFor, now: ctx.state.now, leaseMs: 20,
  }).record;
  ctx.repositories.summaries.fail(failedRun.id, 'provider unavailable', ctx.state.now);
  const expiredRun = ctx.repositories.summaries.claim({
    chatId: ctx.chat.id, reportType: expiredWindow.reportType,
    windowStart: expiredWindow.windowStart, windowEnd: expiredWindow.windowEnd,
    scheduledFor: expiredWindow.scheduledFor, now: ctx.state.now, leaseMs: 20,
  }).record;
  ctx.state.now += 21;

  const summary = fakeSummary(['owned retry']);
  const adapter = fakeAdapter();
  const serviceRunner = runner(ctx, summary, adapter);
  const recovery = new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => true,
    logger: { warn() {} },
  });
  const result = await recovery.recover();
  assert.equal(result.status, 'RECOVERED');
  assert.equal(result.missing.length, 2);
  assert.equal(ctx.repositories.summaries.findById(failedRun.id).status, 'SUCCEEDED');
  assert.equal(ctx.repositories.summaries.findById(expiredRun.id).status, 'SUCCEEDED');
  assert.equal(summary.calls.length, 2);
  assert.equal(adapter.sends, 2);
});

test('failed combined recovery stays retryable and reuses its sealed manifest on the next recovery pass', async (t) => {
  const ctx = fixture(t);
  const summary = fakeSummary(['retryable combined']);
  const adapter = fakeAdapter({ failOnSend: new Set([1]) });
  const serviceRunner = runner(ctx, summary, adapter, { maxAttempts: 1 });
  const recovery = new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => true,
    logger: { warn() {} },
  });
  const failed = await recovery.recover();
  assert.equal(failed.status, 'FAILED');
  assert.equal(ctx.db.prepare("SELECT status FROM summary_runs WHERE report_type='RECOVERY'").get().status, 'FAILED');
  const retried = await recovery.recover();
  assert.equal(retried.status, 'RECOVERED');
  assert.equal(summary.calls.length, 1);
  assert.equal((await recovery.recover()).status, 'NOTHING_MISSING');
});

test('current slot cron/recovery race has one transactional owner and no recovery spam', async (t) => {
  const now = utc('2026-07-22T06:00:00Z'); // exactly 14:00 Kuala Lumpur
  const ctx = fixture(t, now);
  const expected = expectedWindows({ now, timezone: KL, recoveryHours: 24 });
  const current = expected.at(-1);
  expected.slice(0, -1).forEach((window, index) => completeWindow(ctx, window, index));
  ctx.repositories.summaries.claim({
    chatId: ctx.chat.id, reportType: current.reportType,
    windowStart: current.windowStart, windowEnd: current.windowEnd,
    scheduledFor: current.scheduledFor, now, leaseMs: 100,
  });
  const summary = fakeSummary();
  const adapter = fakeAdapter();
  const serviceRunner = runner(ctx, summary, adapter);
  const recovery = new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => true,
    logger: { warn() {} },
  });
  assert.equal((await recovery.recover()).status, 'NOTHING_MISSING');
  assert.equal(adapter.sends, 0);
});

test('scheduled formatter handles empty evidence and AI failure with deterministic PM fallback', async (t) => {
  const ctx = fixture(t);
  const baseAi = {
    ok: false,
    value: { discussionPoints: [], decisions: [], todos: [], uncertainties: [] },
    errorCode: 'AI_SUMMARY_FAILED', modelCalls: 1, omittedChunkCount: 0,
  };
  let records = [];
  const service = new ScheduledSummaryService({
    repositories: ctx.repositories,
    conversationService: {
      async build() {
        return {
          records, attachmentGaps: [],
          stats: { chatMessageCount: records.length, parsedMarkdownCount: 0 }, ai: baseAi,
        };
      },
    },
    timezone: KL,
  });
  const window = descriptor('10:00');
  const empty = await service.build({ chatId: ctx.chat.id, window, now: ctx.state.now });
  records = [{ sourceType: 'CHAT' }];
  const first = await service.build({ chatId: ctx.chat.id, window, now: ctx.state.now });
  const second = await service.build({ chatId: ctx.chat.id, window, now: ctx.state.now });
  const delayed = await service.build({
    chatId: ctx.chat.id, window, now: ctx.state.now, delayed: true,
  });
  assert.match(empty.text, /该时段无新消息/u);
  assert.equal(first.text, second.text);
  assert.match(delayed.text, /延迟补报｜原定 10:00/u);
  assert.match(first.text, /AI (?:群聊)?语义摘要暂不可用/u);
  assert.match(first.text, /全部等待 Tevau 回复（0）/u);
  assert.match(first.text, /昨日工单统计/u);
  assert.ok(first.parts.length >= 1);
});

test('periodic durable recovery retries provider and send failures after invocation exhaustion in one process', async (t) => {
  const ctx = fixture(t, utc('2026-07-22T13:00:00Z'));
  const expected = expectedWindows({ now: ctx.state.now, timezone: KL, recoveryHours: 24 });
  expected.slice(0, -1).forEach((window, index) => completeWindow(ctx, window, `periodic-${index}`));

  let providerReady = false;
  const summary = fakeSummary(['eventual summary']);
  const successfulBuild = summary.build.bind(summary);
  summary.build = async (input) => {
    if (!providerReady) {
      summary.calls.push(input);
      throw new Error('provider unavailable');
    }
    return successfulBuild(input);
  };
  const adapter = fakeAdapter({ failOnSend: new Set([1]) });
  const serviceRunner = runner(ctx, summary, adapter, { maxAttempts: 1 });
  const recovery = new SummaryRecoveryService({
    repositories: ctx.repositories, runner: serviceRunner, chat: ctx.chat,
    timezone: KL, recoveryHours: 24, clock: ctx.clock, adapterReady: () => true,
    logger: { warn() {} },
  });
  const timers = fakeTimers();
  const registrations = [];
  const scheduler = new PersistentSummaryScheduler({
    cron: {
      schedule(expression, callback, options) {
        registrations.push({ expression, callback, options });
        return { stop() {} };
      },
    },
    runner: serviceRunner,
    recovery,
    timezone: KL,
    logger: { log() {}, warn() {}, error() {} },
    recoveryRetryMs: 10,
    recoveryIntervalMs: 50,
    maxRecoveryBackoffMs: 40,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const initial = await Promise.all([scheduler.start(), scheduler.start(), scheduler.start()]);
  assert.ok(initial.every((result) => result.status === 'FAILED'));
  assert.equal(registrations.length, 3);
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(timers.delays, [10]);
  let run = ctx.db.prepare("SELECT * FROM summary_runs WHERE report_type='AUTO_20'").get();
  assert.equal(run.status, 'FAILED');
  assert.equal(run.attempt_count, 1, 'runner exhausted its per-invocation attempt budget');

  providerReady = true;
  await timers.fireNext();
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(timers.delays, [10, 20], 'retry delay grows exponentially while bounded');
  run = ctx.repositories.summaries.findById(run.id);
  assert.equal(run.status, 'FAILED', 'send failure remains durably retryable');
  assert.equal(run.attempt_count, 2);

  await timers.fireNext();
  assert.equal(ctx.repositories.summaries.findById(run.id).status, 'SUCCEEDED');
  assert.equal(ctx.repositories.summaries.findById(run.id).attempt_count, 3);
  assert.equal(summary.calls.length, 2, 'sealed send retry does not rebuild provider output');
  assert.equal(adapter.outgoing.length, 1, 'marker suppresses duplicate after ambiguous send failure');
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(timers.delays, [10, 20, 50], 'healthy recovery resets to periodic cadence');

  scheduler.stop();
  assert.equal(timers.pending.size, 0, 'stop clears the sole periodic recovery timer');
});

test('shutdown stops cron/retry admission and bounded drain waits for in-flight send', async (t) => {
  const ctx = fixture(t);
  const block = deferred();
  const adapter = fakeAdapter({ blockSend: block });
  const serviceRunner = runner(ctx, fakeSummary(), adapter);
  const tasks = [];
  const scheduler = new PersistentSummaryScheduler({
    cron: { schedule() { const task = { stopped: false, stop() { this.stopped = true; } }; tasks.push(task); return task; } },
    runner: serviceRunner,
    recovery: { async recover() { return { status: 'NOTHING_MISSING' }; } },
    timezone: KL,
    logger: { log() {}, warn() {}, error() {} },
  });
  await scheduler.start();
  const operation = serviceRunner.triggerSlot('14:00', { localDate: '2026-07-22' });
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.stop();
  const draining = scheduler.drain({ timeoutMs: 1000 });
  block.resolve();
  assert.equal((await draining).timedOut, false);
  assert.equal((await operation).status, 'SUCCEEDED');
  assert.ok(tasks.every((task) => task.stopped));
  assert.equal((await serviceRunner.triggerSlot('20:00')).status, 'STOPPED');
});
