'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { AttachmentStorage } = require('../services/attachment-storage');
const { IssueService } = require('../services/issue-service');
const { PermissionService } = require('../services/permission-service');
const { DAY_MS, RetentionService } = require('../services/retention-service');
const {
  BackupError,
  BackupService,
  copyStableFile,
  verifyBackupBundle,
} = require('../services/backup-service');
const { FilesystemOffsiteAdapter } = require('../services/filesystem-offsite-adapter');
const { MaintenanceScheduler } = require('../services/maintenance-scheduler');
const { restoreCheck } = require('../services/restore-check-service');
const { PersistentSummaryScheduler } = require('../summaries/persistent-summary-scheduler');

const CHAT_JID = '120300000000000000@g.us';
const MEMBER_JID = '60111111111@c.us';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-maintenance-'));
  const archiveDir = path.join(root, 'attachments');
  const tempDir = path.join(root, 'tmp');
  const backupDir = path.join(root, 'backups');
  const databasePath = path.join(root, 'wsb.sqlite3');
  const db = getDatabase({ filename: databasePath, busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({ jid: CHAT_JID, timezone: 'UTC', now: 2 }).record;
  repositories.permissions.set({
    chatId: chat.id, canonicalJid: MEMBER_JID, role: 'MEMBER', now: 3,
  });
  const permissionService = new PermissionService({ repositories, authorizedChatJid: CHAT_JID });
  let serviceNow = options.now || 10_000_000_000;
  const issueService = new IssueService({
    repositories, permissionService, clock: () => serviceNow++,
  });
  const storage = new AttachmentStorage({ rootDir: archiveDir, tempDir });
  fs.mkdirSync(backupDir, { recursive: true });
  let serial = 0;
  function message(sentAt, extra = {}) {
    serial += 1;
    return repositories.messages.createProcessed({
      whatsappMessageId: `maintenance-message-${serial}`,
      chatId: chat.id,
      senderJid: MEMBER_JID,
      body: `body-${serial}`,
      sentAt,
      receivedAt: sentAt,
      ...extra,
    }, { completedAt: sentAt, claimId: `done-${serial}` }).record;
  }
  function issue(source, suffix = String(serial)) {
    return issueService.create({
      chatJid: CHAT_JID,
      actorJid: MEMBER_JID,
      issueUid: `maintenance-issue-${suffix}`,
      eventUid: `maintenance-event-${suffix}`,
      idempotencyKey: `maintenance-issue-key-${suffix}`,
      title: `Issue ${suffix}`,
      description: 'permanent evidence',
      sourceMessageId: source?.id,
      sourceWhatsappMessageId: source?.whatsapp_message_id,
    }).record;
  }
  function createAttachment({ source, issueId = null, bytes, storageKey, duplicateHash = null }) {
    serial += 1;
    const record = repositories.attachments.create({
      idempotencyKey: `maintenance-attachment-${serial}`,
      messageId: source.id,
      issueId,
      displayName: `evidence-${serial}.txt`,
      declaredMime: 'text/plain',
      sizeBytes: bytes.length,
      retentionClass: issueId ? 'ISSUE' : 'TEMPORARY',
      processingStatus: 'PENDING',
      now: source.sent_at,
    }).record;
    const hash = duplicateHash || crypto.createHash('sha256').update(bytes).digest('hex');
    if (duplicateHash) {
      repositories.attachments.finalizeDuplicate({
        attachmentId: record.id,
        sha256: hash,
        sizeBytes: bytes.length,
        detectedMime: 'text/plain',
        detectedExtension: 'txt',
        displayName: record.display_name,
        now: source.sent_at,
      });
    } else {
      const filename = path.join(archiveDir, ...storageKey.split('/'));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes, { mode: 0o600 });
      repositories.attachments.finalizeArchive({
        attachmentId: record.id,
        sha256: hash,
        storageKey,
        sizeBytes: bytes.length,
        detectedMime: 'text/plain',
        detectedExtension: 'txt',
        displayName: record.display_name,
        retentionClass: issueId ? 'ISSUE' : 'TEMPORARY',
        now: source.sent_at,
      });
    }
    return { record: repositories.attachments.findById(record.id), hash };
  }
  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, archiveDir, tempDir, backupDir, databasePath, db, repositories,
    chat, storage, message, issue, createAttachment,
  };
}

function backupService(ctx, options = {}) {
  return new BackupService({
    db: ctx.db,
    databasePath: ctx.databasePath,
    attachmentsDir: ctx.archiveDir,
    backupDir: ctx.backupDir,
    retentionCount: options.retentionCount ?? 14,
    busyTimeoutMs: 1000,
    clock: options.clock || Date.now,
    logger: options.logger || { log() {}, warn() {}, error() {} },
    offsiteAdapter: options.offsiteAdapter,
    copyFile: options.copyFile,
    verifyBundle: options.verifyBundle,
    interruptedBundleAgeMs: options.interruptedBundleAgeMs,
  });
}

function retentionService(ctx, now, options = {}) {
  return new RetentionService({
    db: ctx.db,
    repositories: ctx.repositories,
    storage: ctx.storage,
    messageDays: 30,
    replySessionGraceMs: options.replySessionGraceMs || DAY_MS,
    tempFileGraceMs: options.tempFileGraceMs || DAY_MS,
    clock: () => now,
    logger: { warn() {}, error() {} },
  });
}

test('retention uses an exact UTC boundary and preserves source/audit evidence as immutable tombstones', async (t) => {
  const now = 10_000_000_000;
  const cutoff = now - 30 * DAY_MS;
  const ctx = fixture(t, { now });
  const oldOrdinary = ctx.message(cutoff - 1);
  const boundary = ctx.message(cutoff);
  const source = ctx.message(cutoff - 2, {
    quotedBody: 'quoted source evidence', quotedSenderJid: MEMBER_JID,
    quotedWhatsappMessageId: 'external-quoted', quotedSentAt: cutoff - 3,
  });
  ctx.issue(source, 'protected');

  const result = await retentionService(ctx, now).run();
  assert.equal(result.cutoff, cutoff);
  assert.equal(ctx.repositories.messages.findByWhatsappId(oldOrdinary.whatsapp_message_id), null);
  assert.equal(ctx.repositories.messages.findByWhatsappId(boundary.whatsapp_message_id).body, boundary.body);
  const tombstone = ctx.repositories.messages.findByWhatsappId(source.whatsapp_message_id, { includeDeleted: true });
  assert.equal(tombstone.is_tombstone, 1);
  assert.equal(tombstone.body, null);
  const snapshot = ctx.db.prepare('SELECT * FROM retention_message_snapshots WHERE message_id=?').get(source.id);
  assert.equal(snapshot.body_snapshot, source.body);
  assert.equal(snapshot.quoted_body_snapshot, 'quoted source evidence');
  assert.throws(() => ctx.db.prepare(
    'UPDATE retention_message_snapshots SET body_snapshot=? WHERE message_id=?'
  ).run('tampered', source.id), /immutable/u);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM issue_events').get().count, 1);
});

test('archived and soft-deleted issue evidence is intentionally permanent per retention spec', async (t) => {
  const now = 10_000_000_000;
  const cutoff = now - 30 * DAY_MS;
  const ctx = fixture(t, { now });
  const archivedSource = ctx.message(cutoff - 10);
  const deletedSource = ctx.message(cutoff - 9);
  const archived = ctx.issue(archivedSource, 'archived-permanent');
  const deleted = ctx.issue(deletedSource, 'deleted-permanent');
  ctx.repositories.issues.update(archived.id, {
    status: 'ARCHIVED', archivedAt: now + 100,
  }, now + 100);
  ctx.repositories.issues.softDelete(deleted.id, now + 200);

  await retentionService(ctx, now).run();
  for (const source of [archivedSource, deletedSource]) {
    const retained = ctx.repositories.messages.findByWhatsappId(source.whatsapp_message_id, {
      includeDeleted: true,
    });
    assert.equal(retained.is_tombstone, 1);
    assert.ok(ctx.db.prepare(
      'SELECT 1 FROM retention_message_snapshots WHERE message_id=?'
    ).get(source.id));
  }
});

test('retention protects issue files/shared blobs and active claims while purging ordinary extracted text/files', async (t) => {
  const now = 10_000_000_000;
  const cutoff = now - 30 * DAY_MS;
  const ctx = fixture(t, { now });
  const tempSource = ctx.message(cutoff - 10);
  const issueSource = ctx.message(cutoff - 9);
  const issue = ctx.issue(issueSource, 'shared');
  const bytes = Buffer.from('shared permanent bytes');
  const temporary = ctx.createAttachment({
    source: tempSource, bytes, storageKey: 'temporary/aa/shared.txt',
  });
  const permanent = ctx.createAttachment({
    source: issueSource, issueId: issue.id, bytes, storageKey: 'unused', duplicateHash: temporary.hash,
  });
  const lateLinkedEvidence = ctx.createAttachment({
    source: issueSource,
    bytes: Buffer.from('source evidence promoted by retention'),
    storageKey: 'temporary/bb/source-evidence.txt',
  });
  ctx.db.prepare(`UPDATE attachments SET extracted_text='ordinary markdown',
    extracted_char_count=17, parse_status='PARSED', processing_status='READY', retryable=0
    WHERE id=?`).run(temporary.record.id);

  const failedSource = ctx.message(cutoff - 9);
  const failed = ctx.repositories.attachments.create({
    idempotencyKey: 'failed-old-attachment', messageId: failedSource.id,
    displayName: 'failed.txt', sizeBytes: 0, processingStatus: 'PENDING', now: failedSource.sent_at,
  }).record;
  ctx.repositories.attachments.markCaptureFailed({
    attachmentId: failed.id, code: 'DOWNLOAD_FAILED', message: 'old failure',
    retryable: false, now: failedSource.sent_at,
  });
  const activeSource = ctx.message(cutoff - 8);
  const active = ctx.repositories.attachments.create({
    idempotencyKey: 'active-old-attachment', messageId: activeSource.id,
    displayName: 'active.txt', sizeBytes: 0, processingStatus: 'PENDING', now: activeSource.sent_at,
  }).record;
  ctx.repositories.attachments.claimForQueue({ attachmentId: active.id, claimId: 'active-claim', now });
  const summaryRun = ctx.repositories.summaries.claim({
    runUid: 'maintenance-active-summary', chatId: ctx.chat.id, reportType: 'MANUAL',
    windowStart: now - 1000, windowEnd: now, scheduledFor: now,
    leaseMs: 60_000, now,
  }).record;

  const result = await retentionService(ctx, now).run();
  assert.equal(ctx.repositories.attachments.findById(temporary.record.id), null);
  assert.ok(ctx.repositories.attachments.findById(permanent.record.id));
  const promoted = ctx.repositories.attachments.findById(lateLinkedEvidence.record.id);
  assert.equal(promoted.issue_id, issue.id);
  assert.equal(promoted.issue_chat_id, ctx.chat.id, 'promoted issue/chat pairing must match');
  assert.equal(promoted.retention_class, 'ISSUE');
  assert.ok(ctx.repositories.attachments.findById(active.id));
  assert.equal(ctx.repositories.attachments.findById(failed.id), null);
  assert.ok(ctx.repositories.messages.findByWhatsappId(activeSource.whatsapp_message_id));
  assert.equal(ctx.repositories.summaries.findById(summaryRun.id).lease_expires_at, summaryRun.lease_expires_at);
  assert.ok(fs.existsSync(path.join(ctx.archiveDir, 'temporary/aa/shared.txt')));
  assert.deepEqual(result.removedBlobFiles, []);
});

test('retention purges terminal reply sessions after grace and old staging files but leaves boundary/new files', async (t) => {
  const now = 10_000_000_000;
  const ctx = fixture(t, { now });
  const source = ctx.message(now - 2 * DAY_MS);
  const issue = ctx.issue(source, 'session');
  const session = ctx.repositories.replyMatches.create({
    sessionUid: 'expired-session', token: 'EXPD1234', chatId: ctx.chat.id,
    sourceMessageId: source.id, sourceWhatsappMessageId: source.whatsapp_message_id,
    ericJid: MEMBER_JID, replyText: 'unconfirmed reply',
    candidates: [{ issueId: issue.id, confidence: 0.5, reason: 'candidate' }],
    createdAt: now - 3 * DAY_MS, expiresAt: now - 2 * DAY_MS,
  }).record;
  ctx.db.prepare("UPDATE reply_match_sessions SET status='EXPIRED', updated_at=? WHERE id=?")
    .run(now - 2 * DAY_MS, session.id);

  const oldPart = path.join(ctx.tempDir, 'old.part');
  const boundaryPart = path.join(ctx.tempDir, 'boundary.part');
  const newPart = path.join(ctx.tempDir, 'new.part');
  for (const file of [oldPart, boundaryPart, newPart]) fs.writeFileSync(file, 'temporary');
  const quarantine = path.join(ctx.tempDir, 'quarantine');
  const nested = path.join(quarantine, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const oldQuarantined = path.join(nested, 'old.symlink-record');
  const currentQuarantined = path.join(quarantine, 'current.special-record');
  fs.writeFileSync(oldQuarantined, 'old quarantined bytes');
  fs.writeFileSync(currentQuarantined, 'current quarantined bytes');
  const outside = path.join(ctx.root, 'outside-current');
  fs.writeFileSync(outside, 'must survive');
  const oldLink = path.join(quarantine, 'old-link');
  fs.symlinkSync(outside, oldLink);
  const fileCutoff = now - DAY_MS;
  fs.utimesSync(oldPart, new Date(fileCutoff - 1000), new Date(fileCutoff - 1000));
  fs.utimesSync(boundaryPart, new Date(fileCutoff), new Date(fileCutoff));
  fs.utimesSync(newPart, new Date(fileCutoff + 1000), new Date(fileCutoff + 1000));
  fs.utimesSync(oldQuarantined, new Date(fileCutoff - 1000), new Date(fileCutoff - 1000));
  fs.utimesSync(currentQuarantined, new Date(fileCutoff + 1000), new Date(fileCutoff + 1000));
  fs.lutimesSync(oldLink, new Date(fileCutoff - 1000), new Date(fileCutoff - 1000));

  const result = await retentionService(ctx, now).run();
  assert.equal(ctx.repositories.replyMatches.get(session.id), null);
  assert.equal(fs.existsSync(oldPart), false);
  assert.equal(fs.existsSync(boundaryPart), true);
  assert.equal(fs.existsSync(newPart), true);
  assert.equal(fs.existsSync(oldQuarantined), false);
  assert.equal(fs.existsSync(oldLink), false, 'old quarantine symlink is unlinked, never followed');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'must survive');
  assert.equal(fs.existsSync(currentQuarantined), true);
  assert.ok(result.staging.removed.includes('quarantine/nested/old.symlink-record'));
});

test('retention refuses a symlink quarantine parent and stops accepting after stop', async (t) => {
  const now = 10_000_000_000;
  const ctx = fixture(t, { now });
  const outside = path.join(ctx.root, 'outside-quarantine');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'evidence'), 'untouched');
  fs.symlinkSync(outside, path.join(ctx.tempDir, 'quarantine'));
  const service = retentionService(ctx, now);
  await assert.rejects(service.run(), (error) => error.code === 'UNSAFE_QUARANTINE_PATH');
  assert.equal(fs.readFileSync(path.join(outside, 'evidence'), 'utf8'), 'untouched');
  service.stop();
  await assert.rejects(service.run(), (error) => error.code === 'STOPPED');
});

test('large retention ID sets are deleted in bounded chunks', async (t) => {
  const now = 10_000_000_000;
  const cutoff = now - 30 * DAY_MS;
  const ctx = fixture(t, { now });
  for (let index = 0; index < 275; index += 1) {
    const source = ctx.message(cutoff - index - 1);
    const attachment = ctx.repositories.attachments.create({
      idempotencyKey: `chunk-attachment-${index}`,
      messageId: source.id,
      displayName: `${index}.txt`,
      sizeBytes: 0,
      processingStatus: 'PENDING',
      now: source.sent_at,
    }).record;
    ctx.repositories.attachments.markCaptureFailed({
      attachmentId: attachment.id,
      code: 'OLD_FAILURE',
      message: 'purge in chunks',
      retryable: false,
      now: source.sent_at,
    });
  }
  const result = await retentionService(ctx, now).run();
  assert.equal(result.temporary.attachmentIds.length, 275);
  assert.equal(result.ordinaryDeleted, 275);
});

test('verified online backup includes committed WAL writes and issue attachment manifest', async (t) => {
  const ctx = fixture(t);
  const source = ctx.message(100);
  const issue = ctx.issue(source, 'backup');
  const bytes = Buffer.from('permanent backup attachment');
  ctx.createAttachment({ source, issueId: issue.id, bytes, storageKey: `issues/${issue.id}/evidence.txt` });
  // This committed row lives in WAL; no checkpoint/copy of the live DB is used.
  ctx.message(101, { body: 'committed WAL message' });
  assert.ok(fs.existsSync(`${ctx.databasePath}-wal`));

  const result = await backupService(ctx, { clock: () => 20_000_000_000 }).run();
  const check = await verifyBackupBundle(result.bundlePath, { busyTimeoutMs: 1000 });
  assert.equal(check.manifest.attachments.length, 1);
  assert.ok(check.manifest.files.some((file) => file.kind === 'issue-attachment'
    && file.sha256 === crypto.createHash('sha256').update(bytes).digest('hex')));
  const snapshot = check.bundlePath + '/database.sqlite3';
  const SnapshotDb = require('better-sqlite3');
  const restored = new SnapshotDb(snapshot, { readonly: true });
  assert.equal(restored.prepare("SELECT body FROM messages WHERE body='committed WAL message'").get().body,
    'committed WAL message');
  restored.close();
});

test('online backup tolerates concurrent committed writes without corrupting its point-in-time snapshot', async (t) => {
  const ctx = fixture(t);
  for (let index = 0; index < 2000; index += 1) ctx.message(1000 + index);
  const originalBackup = ctx.db.backup.bind(ctx.db);
  let concurrent = false;
  ctx.db.backup = (destination) => originalBackup(destination, {
    progress() {
      if (!concurrent) {
        concurrent = true;
        ctx.message(5000, { body: 'concurrent WAL commit' });
      }
      return 16;
    },
  });
  const result = await backupService(ctx).run();
  assert.equal(concurrent, true);
  await assert.doesNotReject(verifyBackupBundle(result.bundlePath, { busyTimeoutMs: 1000 }));
  assert.ok(ctx.db.prepare("SELECT id FROM messages WHERE body='concurrent WAL commit'").get());
});

test('backup rejects attachment symlinks and detects source mutation during copy', async (t) => {
  const ctx = fixture(t);
  const source = ctx.message(100);
  const issue = ctx.issue(source, 'unsafe');
  const bytes = Buffer.alloc(256 * 1024, 0x61);
  const linked = ctx.createAttachment({ source, issueId: issue.id, bytes, storageKey: `issues/${issue.id}/real.bin` });
  const issueDirectory = path.join(ctx.archiveDir, `issues/${issue.id}`);
  const outsideDirectory = path.join(ctx.root, 'outside-issue-directory');
  fs.renameSync(issueDirectory, outsideDirectory);
  fs.symlinkSync(outsideDirectory, issueDirectory);
  await assert.rejects(backupService(ctx).run(), (error) => error.code === 'ATTACHMENT_SYMLINK');

  fs.unlinkSync(issueDirectory);
  fs.renameSync(outsideDirectory, issueDirectory);
  const real = path.join(issueDirectory, 'real.bin');
  let changed = false;
  const mutatingCopy = (from, to) => copyStableFile(from, to, {
    chunkBytes: 1024,
    async onChunk() {
      if (!changed) {
        changed = true;
        fs.appendFileSync(from, 'mutation');
      }
    },
  });
  await assert.rejects(backupService(ctx, { copyFile: mutatingCopy }).run(),
    (error) => error.code === 'ATTACHMENT_MUTATED');
  assert.equal(fs.readdirSync(ctx.backupDir).filter((name) => !name.startsWith('.tmp')).length, 0);
  assert.ok(ctx.repositories.attachments.findById(linked.record.id));
});

test('restore checks reject traversal/unknown/missing/corrupt files and corrupt databases', async (t) => {
  const ctx = fixture(t);
  const source = ctx.message(100);
  const issue = ctx.issue(source, 'restore');
  ctx.createAttachment({ source, issueId: issue.id, bytes: Buffer.from('restore bytes'), storageKey: `issues/${issue.id}/restore.txt` });
  const result = await backupService(ctx).run();
  await assert.doesNotReject(restoreCheck(result.bundlePath, { busyTimeoutMs: 1000, tempDir: ctx.root }));

  const manifestPath = path.join(result.bundlePath, 'manifest.json');
  const originalManifest = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(originalManifest);
  manifest.files[0].path = '../escape';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreCheck(result.bundlePath, { busyTimeoutMs: 1000 }),
    (error) => error.code === 'INVALID_MANIFEST_PATH');
  fs.writeFileSync(manifestPath, originalManifest);

  fs.writeFileSync(path.join(result.bundlePath, 'unknown'), 'unknown');
  await assert.rejects(verifyBackupBundle(result.bundlePath),
    (error) => error.code === 'UNKNOWN_OR_MISSING_FILE');
  fs.unlinkSync(path.join(result.bundlePath, 'unknown'));

  const restoredManifest = JSON.parse(originalManifest);
  const attachmentFile = restoredManifest.files.find((file) => file.kind === 'issue-attachment').path;
  const attachmentPath = path.join(result.bundlePath, attachmentFile);
  const attachmentBytes = fs.readFileSync(attachmentPath);
  fs.unlinkSync(attachmentPath);
  await assert.rejects(verifyBackupBundle(result.bundlePath),
    (error) => error.code === 'UNKNOWN_OR_MISSING_FILE');
  fs.writeFileSync(attachmentPath, attachmentBytes);
  fs.appendFileSync(attachmentPath, 'corrupt');
  await assert.rejects(verifyBackupBundle(result.bundlePath),
    (error) => error.code === 'FILE_HASH_MISMATCH');

  // Separate DB-corruption bundle so file hashes are internally consistent but
  // SQLite integrity/migration validation still refuses it.
  const second = await backupService(ctx).run();
  const secondManifestPath = path.join(second.bundlePath, 'manifest.json');
  const secondManifest = JSON.parse(fs.readFileSync(secondManifestPath, 'utf8'));
  const dbFile = path.join(second.bundlePath, 'database.sqlite3');
  fs.writeFileSync(dbFile, Buffer.from('not sqlite'));
  const dbDigest = crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
  const dbEntry = secondManifest.files.find((file) => file.kind === 'database');
  dbEntry.bytes = fs.statSync(dbFile).size;
  dbEntry.sha256 = dbDigest;
  fs.writeFileSync(secondManifestPath, JSON.stringify(secondManifest));
  await assert.rejects(verifyBackupBundle(second.bundlePath),
    (error) => ['INVALID_DATABASE', 'CORRUPT_DATABASE'].includes(error.code));
});

test('backup filesystem lock prevents concurrent services from clobbering an active temp bundle', async (t) => {
  const ctx = fixture(t);
  const originalBackup = ctx.db.backup.bind(ctx.db);
  let entered;
  const enteredBackup = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ctx.db.backup = async (...args) => {
    entered();
    await gate;
    return originalBackup(...args);
  };
  const first = backupService(ctx);
  const active = first.run();
  await enteredBackup;
  const activeTemps = fs.readdirSync(ctx.backupDir).filter((name) => name.startsWith('.tmp-wsb-'));
  assert.equal(activeTemps.length, 1);
  await assert.rejects(backupService(ctx).run(), (error) => error.code === 'BACKUP_LOCKED');
  assert.ok(fs.existsSync(path.join(ctx.backupDir, activeTemps[0])));
  release();
  await active;
  assert.equal(fs.existsSync(path.join(ctx.backupDir, '.backup.lock')), false);
});

test('backup cleanup removes only stale interrupted bundles with no live owner', async (t) => {
  const ctx = fixture(t);
  const stale = path.join(ctx.backupDir, '.tmp-wsb-stale');
  const fresh = path.join(ctx.backupDir, '.tmp-wsb-fresh');
  const live = path.join(ctx.backupDir, '.tmp-wsb-live');
  for (const directory of [stale, fresh, live]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(live, '.backup-owner.json'), JSON.stringify({
    runId: 'other-live-run', pid: process.pid, startedAt: Date.now() - 10_000_000,
  }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(live, old, old);

  await backupService(ctx).run();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true, 'age guard preserves a fresh interrupted bundle');
  assert.equal(fs.existsSync(live), true, 'a live owner is never reclaimed');
});

test('backup cleans interrupted temp bundles, keeps 14 verified bundles, and never prunes after failure', async (t) => {
  const ctx = fixture(t);
  const interrupted = path.join(ctx.backupDir, '.tmp-wsb-interrupted');
  fs.mkdirSync(interrupted);
  fs.writeFileSync(path.join(interrupted, 'partial'), 'partial');
  const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(interrupted, staleTime, staleTime);
  let now = 30_000_000_000;
  for (let index = 0; index < 15; index += 1) {
    await backupService(ctx, { clock: () => now++, retentionCount: 14 }).run();
  }
  assert.equal(fs.existsSync(interrupted), false);
  const bundles = fs.readdirSync(ctx.backupDir).filter((name) => name.startsWith('wsb-'));
  assert.equal(bundles.length, 14);
  const before = new Set(bundles);
  const broken = backupService(ctx, {
    retentionCount: 1,
    copyFile: async () => { throw new BackupError('INJECTED', 'fail before publish'); },
  });
  // Add an attachment so injected copy runs.
  const source = ctx.message(100);
  const issue = ctx.issue(source, 'prune-failure');
  ctx.createAttachment({ source, issueId: issue.id, bytes: Buffer.from('bytes'), storageKey: `issues/${issue.id}/bytes` });
  await assert.rejects(broken.run(), /fail before publish/u);
  assert.deepEqual(new Set(fs.readdirSync(ctx.backupDir).filter((name) => name.startsWith('wsb-'))), before);
  assert.equal(fs.existsSync(path.join(ctx.backupDir, '.backup.lock')), false);
});

test('post-publish verification failure removes the new bundle and aborts all pruning', async (t) => {
  const ctx = fixture(t);
  const good = await backupService(ctx, { retentionCount: 1 }).run();
  const before = new Set(fs.readdirSync(ctx.backupDir).filter((name) => name.startsWith('wsb-')));
  let verification = 0;
  const failAfterPublish = async (bundlePath, options) => {
    verification += 1;
    if (verification === 2) throw new BackupError('INJECTED_POST_PUBLISH', 'published bytes changed');
    return verifyBackupBundle(bundlePath, options);
  };
  await assert.rejects(backupService(ctx, {
    retentionCount: 1,
    verifyBundle: failAfterPublish,
  }).run(), (error) => error.code === 'POST_PUBLISH_VERIFY_FAILED');
  assert.deepEqual(
    new Set(fs.readdirSync(ctx.backupDir).filter((name) => name.startsWith('wsb-'))),
    before,
    'last known-good bundle floor must remain unchanged'
  );
  await assert.doesNotReject(verifyBackupBundle(good.bundlePath));
  assert.equal(fs.existsSync(path.join(ctx.backupDir, '.backup.lock')), false);
});

test('filesystem offsite publishes atomically; adapter failure retains successful local bundle', async (t) => {
  const ctx = fixture(t);
  const offsiteDir = path.join(ctx.root, 'offsite');
  const adapter = new FilesystemOffsiteAdapter({ destinationDir: offsiteDir, busyTimeoutMs: 1000 });
  const success = await backupService(ctx, { offsiteAdapter: adapter }).run();
  assert.equal(success.offsite.status, 'SUCCEEDED');
  const offsiteBundle = path.join(offsiteDir, success.bundleName);
  await assert.doesNotReject(verifyBackupBundle(offsiteBundle, { busyTimeoutMs: 1000 }));
  const manifestPath = path.join(offsiteBundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  reordered.attachments = reordered.attachments.map((entry) => Object.fromEntries(
    Object.entries(entry).reverse()
  ));
  fs.writeFileSync(manifestPath, JSON.stringify(reordered));
  const repeated = await adapter.upload({
    bundlePath: success.bundlePath,
    bundleName: success.bundleName,
  });
  assert.equal(repeated.alreadyPresent, true, 'manifest identity ignores JSON key order');

  const failure = await backupService(ctx, {
    offsiteAdapter: { async upload() { throw new Error('offsite unavailable'); } },
  }).run();
  assert.equal(failure.offsite.status, 'FAILED');
  assert.ok(fs.existsSync(failure.bundlePath));
  assert.equal(ctx.db.prepare("SELECT status FROM maintenance_runs WHERE operation='OFFSITE' ORDER BY id DESC").get().status,
    'FAILED');
});

test('offsite rejects noncanonical names and containment in either direction', async (t) => {
  const ctx = fixture(t);
  const local = await backupService(ctx).run();
  const parentAdapter = new FilesystemOffsiteAdapter({ destinationDir: ctx.root, busyTimeoutMs: 1000 });
  await assert.rejects(parentAdapter.upload({
    bundlePath: local.bundlePath,
    bundleName: local.bundleName,
  }), (error) => error.code === 'UNSAFE_OFFSITE_LAYOUT');

  const nestedDestination = path.join(local.bundlePath, 'nested-offsite');
  const nestedAdapter = new FilesystemOffsiteAdapter({
    destinationDir: nestedDestination,
    busyTimeoutMs: 1000,
  });
  await assert.rejects(nestedAdapter.upload({
    bundlePath: local.bundlePath,
    bundleName: local.bundleName,
  }), (error) => error.code === 'UNSAFE_OFFSITE_LAYOUT');
  await assert.rejects(nestedAdapter.upload({
    bundlePath: local.bundlePath,
    bundleName: '../not-canonical',
  }), (error) => error.code === 'INVALID_BUNDLE_NAME');
});

test('restore preflight fails for insufficient temporary space before creating a copy', async (t) => {
  const ctx = fixture(t);
  const local = await backupService(ctx).run();
  const restoreTemp = path.join(ctx.root, 'restore-preflight');
  fs.mkdirSync(restoreTemp);
  await assert.rejects(restoreCheck(local.bundlePath, {
    busyTimeoutMs: 1000,
    tempDir: restoreTemp,
    async statfs() { return { bsize: 4096n, bavail: 0n }; },
  }), (error) => error.code === 'INSUFFICIENT_TEMP_SPACE' && /requires/u.test(error.message));
  assert.deepEqual(fs.readdirSync(restoreTemp), []);
});

test('maintenance scheduler registers once, retries only next cron, and stop drains active work', async () => {
  const registrations = [];
  let releaseCronStop;
  const cronStopGate = new Promise((resolve) => { releaseCronStop = resolve; });
  const task = { stops: 0, stop() { this.stops += 1; return cronStopGate; } };
  const cron = {
    validate: () => true,
    schedule(expression, callback, options) {
      registrations.push({ expression, callback, options });
      return task;
    },
  };
  let cleanupCalls = 0;
  let backupCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const retention = {
    async run() { cleanupCalls += 1; return {}; }, stop() {}, async drain() {},
  };
  const backup = {
    async run() { backupCalls += 1; await gate; return {}; }, stop() {}, async drain() {},
  };
  const scheduler = new MaintenanceScheduler({
    cron, retention, backup, expression: '5 3 * * *', timezone: 'UTC',
    logger: { log() {}, warn() {}, error() {} },
  });
  scheduler.start().start();
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].options, { timezone: 'UTC', noOverlap: true });
  const active = scheduler.run();
  const stopping = scheduler.stop();
  release();
  releaseCronStop();
  await Promise.all([active, stopping, scheduler.drain()]);
  assert.equal(cleanupCalls, 1);
  assert.equal(backupCalls, 1);
  assert.equal(task.stops, 1);
});

test('maintenance cron callback catches synchronous run failures', async () => {
  let callback;
  const errors = [];
  const scheduler = new MaintenanceScheduler({
    cron: {
      validate: () => true,
      schedule(expression, registered) { callback = registered; return { stop() {} }; },
    },
    retention: {
      run() { throw new Error('synchronous cleanup failure'); },
      stop() {},
      async drain() {},
    },
    backup: { async run() {}, stop() {}, async drain() {} },
    logger: { log() {}, warn() {}, error(line) { errors.push(line); } },
  });
  scheduler.start();
  await callback();
  assert.ok(errors.some((line) => /synchronous cleanup failure/u.test(line)));
  await scheduler.stop();
});

test('reconnect-ready integration registers summary and maintenance schedulers once each', async () => {
  const registrations = [];
  const cron = {
    validate: () => true,
    schedule(expression, callback, options) {
      registrations.push({ expression, callback, options });
      return { stop() {} };
    },
  };
  const summary = new PersistentSummaryScheduler({
    cron,
    runner: { async triggerSlot() {}, stop() {}, async drain() {} },
    recovery: { async recover() { return { status: 'NOTHING_MISSING' }; } },
    logger: { log() {}, warn() {}, error() {} },
  });
  const maintenance = new MaintenanceScheduler({
    cron,
    retention: { async run() {}, stop() {}, async drain() {} },
    backup: { async run() {}, stop() {}, async drain() {} },
    logger: { log() {}, warn() {}, error() {} },
  });
  const ready = async () => {
    await summary.start();
    maintenance.start();
  };
  await Promise.all([ready(), ready(), ready()]);
  assert.deepEqual(registrations.map((entry) => entry.expression), [
    '0 10 * * *', '0 14 * * *', '0 20 * * *', '30 2 * * *',
  ]);
  summary.stop();
  await maintenance.stop();
});

test('db:restore-check CLI verifies a bundle without touching production', async (t) => {
  const ctx = fixture(t);
  const before = fs.statSync(ctx.databasePath).mtimeMs;
  const result = await backupService(ctx).run();
  const command = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'db-restore-check.js'),
    result.bundlePath,
    '--temp-dir', ctx.root,
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /Restore check OK/u);
  assert.equal(fs.statSync(ctx.databasePath).mtimeMs, before);
});
