'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { checkForeignKeys, checkIntegrity } = require('../db/check');
const {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  readMigrationState,
} = require('../db/migrate');

const BUNDLE_FORMAT = 'wsb-backup-bundle';
const BUNDLE_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const DATABASE_NAME = 'database.sqlite3';
const BUNDLE_NAME = /^wsb-(\d{8}T\d{9}Z)-([a-f0-9]{8})$/u;
const BACKUP_LOCK_NAME = '.backup.lock';
const TEMP_OWNER_NAME = '.backup-owner.json';
const DEFAULT_INTERRUPTED_BUNDLE_AGE_MS = 60 * 60 * 1000;

class BackupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'BackupError';
    this.code = code;
  }
}

function isContained(root, candidate, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function manifestIdentity(manifest) {
  return crypto.createHash('sha256').update(stableJson(manifest)).digest('hex');
}

function assertRelativeManifestPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
      || value === '.' || value.startsWith('../')) {
    throw new BackupError('INVALID_MANIFEST_PATH', `Unsafe manifest path: ${String(value)}`);
  }
  return value;
}

function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new BackupError('UNSAFE_DIRECTORY', `${resolved} must be a real directory`);
  }
  if (process.platform !== 'win32') fs.chmodSync(resolved, 0o700);
  return fs.realpathSync(resolved);
}

function assertSafeSource(root, storageKey) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new BackupError('UNSAFE_ATTACHMENT_PATH', 'Attachment storage root changed or became unsafe');
  }
  if (typeof storageKey !== 'string' || !storageKey || storageKey.includes('\0')
      || path.isAbsolute(storageKey)) {
    throw new BackupError('UNSAFE_ATTACHMENT_PATH', 'Attachment storage key is unsafe');
  }
  const normalizedKey = storageKey.split(path.sep).join('/');
  assertRelativeManifestPath(normalizedKey);
  const candidate = path.resolve(root, ...normalizedKey.split('/'));
  if (!isContained(root, candidate)) {
    throw new BackupError('UNSAFE_ATTACHMENT_PATH', 'Attachment path escapes storage');
  }
  let current = root;
  for (const component of normalizedKey.split('/')) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new BackupError('ATTACHMENT_SYMLINK', `Attachment path contains a symlink: ${normalizedKey}`);
    }
  }
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (!stat.isFile()) throw new BackupError('ATTACHMENT_MISSING', `Attachment is not a file: ${normalizedKey}`);
  if (fs.realpathSync(candidate) !== candidate) {
    throw new BackupError('UNSAFE_ATTACHMENT_PATH', `Attachment path is not canonical: ${normalizedKey}`);
  }
  return { candidate, normalizedKey, stat };
}

function sameStableStat(before, after) {
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
  return fields.every((field) => before[field] === after[field]);
}

async function copyStableFile(source, destination, options = {}) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const sourceHandle = await fs.promises.open(source, flags);
  let destinationHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile()) throw new BackupError('ATTACHMENT_NOT_FILE', 'Backup source is not a regular file');
    if (options.expectedStat && !sameStableStat(options.expectedStat, before)) {
      throw new BackupError('ATTACHMENT_MUTATED', `Attachment changed before backup opened it: ${source}`);
    }
    if (options.allowedRoot) {
      const root = path.resolve(options.allowedRoot);
      const namedPath = await fs.promises.realpath(source);
      if (!isContained(root, namedPath) || namedPath !== path.resolve(source)) {
        throw new BackupError('UNSAFE_ATTACHMENT_PATH', 'Opened attachment escaped storage');
      }
      // Linux exposes the path of the already-open descriptor, closing the
      // intermediate-parent swap race that a leaf-only O_NOFOLLOW cannot catch.
      if (process.platform === 'linux') {
        const openedPath = await fs.promises.realpath(`/proc/self/fd/${sourceHandle.fd}`);
        if (!isContained(root, openedPath) || openedPath !== path.resolve(source)) {
          throw new BackupError('UNSAFE_ATTACHMENT_PATH', 'Opened attachment escaped storage');
        }
      }
    }
    destinationHandle = await fs.promises.open(destination, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(options.chunkBytes || 64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      await destinationHandle.write(chunk, 0, bytesRead, position);
      hash.update(chunk);
      position += bytesRead;
      await options.onChunk?.({ source, destination, bytesCopied: position });
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameStableStat(before, after) || BigInt(position) !== before.size) {
      throw new BackupError('ATTACHMENT_MUTATED', `Attachment changed while it was being backed up: ${source}`);
    }
    return { bytes: position, sha256: hash.digest('hex') };
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle.close().catch(() => {});
  }
}

async function hashFile(filename) {
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BackupError('NOT_REGULAR_FILE', `${filename} is not a regular file`);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { bytes: position, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function sealSnapshotDatabase(filename, options = {}) {
  let db;
  try {
    db = new Database(filename, { fileMustExist: true, timeout: options.busyTimeoutMs ?? 5000 });
    db.pragma('foreign_keys = ON');
    // The online destination can inherit WAL mode. Collapse only the isolated
    // snapshot to one self-contained DB file before hashing/publication.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const mode = String(db.pragma('journal_mode = DELETE', { simple: true })).toLowerCase();
    if (mode !== 'delete') throw new BackupError('SNAPSHOT_SEAL_FAILED', `snapshot journal_mode=${mode}`);
  } finally {
    db?.close();
  }
}

function verifySnapshotDatabase(filename, options = {}) {
  let db;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true, timeout: options.busyTimeoutMs ?? 5000 });
    db.pragma('foreign_keys = ON');
    const integrity = checkIntegrity(db);
    if (!integrity.ok) throw new BackupError('CORRUPT_DATABASE', `integrity_check failed: ${integrity.messages.join('; ')}`);
    const foreignKeys = checkForeignKeys(db);
    if (!foreignKeys.ok) throw new BackupError('FOREIGN_KEY_VIOLATION', 'foreign_key_check failed');
    const migrations = loadMigrations(options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
    const migration = readMigrationState(db, migrations, { requireCurrent: true });
    return { db, integrity, foreignKeys, schemaVersion: migration.currentVersion };
  } catch (error) {
    db?.close();
    if (error instanceof BackupError) throw error;
    throw new BackupError('INVALID_DATABASE', `Snapshot validation failed: ${error.message}`, { cause: error });
  }
}

function listIssueAttachments(db) {
  return db.prepare(`
    SELECT a.id AS attachment_id, a.attachment_uid, a.issue_id, i.public_id,
      a.display_name, a.detected_mime, a.size_bytes, a.processing_status,
      a.parse_status, a.blob_sha256, b.storage_key, b.size_bytes AS blob_size_bytes
    FROM attachments a
    JOIN issues i ON i.id=a.issue_id
    LEFT JOIN attachment_blobs b ON b.sha256=a.blob_sha256
    WHERE a.deleted_at IS NULL AND a.issue_id IS NOT NULL
    ORDER BY a.id
  `).all();
}

async function walkBundle(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink()) throw new BackupError('BUNDLE_SYMLINK', 'Backup bundle contains a symlink');
      if (stat.isDirectory()) await visit(candidate);
      else if (stat.isFile()) files.push(path.relative(root, candidate).split(path.sep).join('/'));
      else throw new BackupError('UNKNOWN_BUNDLE_ENTRY', 'Backup bundle contains a special file');
    }
  };
  await visit(root);
  return files.sort();
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.format !== BUNDLE_FORMAT || manifest.version !== BUNDLE_VERSION
      || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0
      || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.attachments)) {
    throw new BackupError('INVALID_MANIFEST', 'Backup manifest schema is invalid or unsupported');
  }
  const topKeys = Object.keys(manifest).sort();
  const allowed = ['attachments', 'createdAt', 'files', 'format', 'schemaVersion', 'version'].sort();
  if (JSON.stringify(topKeys) !== JSON.stringify(allowed)) {
    throw new BackupError('INVALID_MANIFEST', 'Backup manifest has missing or unknown fields');
  }
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,kind,path,sha256'
        || !['database', 'issue-attachment'].includes(file.kind)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new BackupError('INVALID_MANIFEST', 'Backup file manifest entry is invalid');
    }
    assertRelativeManifestPath(file.path);
    if (file.path === MANIFEST_NAME || paths.has(file.path)) {
      throw new BackupError('INVALID_MANIFEST', 'Backup manifest contains duplicate/reserved paths');
    }
    paths.add(file.path);
  }
  if (manifest.files.filter((file) => file.kind === 'database' && file.path === DATABASE_NAME).length !== 1) {
    throw new BackupError('INVALID_MANIFEST', `Backup manifest must contain exactly one ${DATABASE_NAME}`);
  }
  return paths;
}

async function verifyBackupBundle(bundlePath, options = {}) {
  const root = path.resolve(bundlePath);
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BackupError('INVALID_BUNDLE', 'Backup bundle must be a real directory');
  }
  const manifestPath = path.join(root, MANIFEST_NAME);
  const manifestStat = await fs.promises.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new BackupError('INVALID_MANIFEST', 'Backup manifest must be a regular file');
  }
  let manifest;
  try { manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')); } catch (error) {
    throw new BackupError('INVALID_MANIFEST', `Cannot parse backup manifest: ${error.message}`, { cause: error });
  }
  const expectedPaths = validateManifestShape(manifest);
  const actualPaths = await walkBundle(root);
  const expectedAll = [...expectedPaths, MANIFEST_NAME].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedAll)) {
    throw new BackupError('UNKNOWN_OR_MISSING_FILE', 'Bundle has corrupt, missing, or unknown files');
  }
  for (const file of manifest.files) {
    const candidate = path.resolve(root, ...file.path.split('/'));
    if (!isContained(root, candidate)) throw new BackupError('INVALID_MANIFEST_PATH', 'Bundle path escapes root');
    const digest = await hashFile(candidate);
    if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
      throw new BackupError('FILE_HASH_MISMATCH', `Backup file verification failed: ${file.path}`);
    }
  }

  const databasePath = path.join(root, DATABASE_NAME);
  const validated = verifySnapshotDatabase(databasePath, options);
  try {
    if (validated.schemaVersion !== manifest.schemaVersion) {
      throw new BackupError('SCHEMA_VERSION_MISMATCH', 'Manifest schema version differs from database');
    }
    const databaseAttachments = listIssueAttachments(validated.db);
    if (databaseAttachments.length !== manifest.attachments.length) {
      throw new BackupError('ATTACHMENT_MANIFEST_MISMATCH', 'Issue attachment metadata count differs from database');
    }
    const filesByPath = new Map(manifest.files.map((file) => [file.path, file]));
    for (let index = 0; index < databaseAttachments.length; index += 1) {
      const row = databaseAttachments[index];
      const record = manifest.attachments[index];
      const expectedRecord = {
        attachmentId: row.attachment_id,
        attachmentUid: row.attachment_uid,
        issueId: row.issue_id,
        publicId: row.public_id,
        displayName: row.display_name,
        detectedMime: row.detected_mime,
        sizeBytes: row.size_bytes,
        processingStatus: row.processing_status,
        parseStatus: row.parse_status,
        blobSha256: row.blob_sha256,
        storageKey: row.storage_key,
        bundlePath: row.blob_sha256 ? `attachments/${row.blob_sha256}` : null,
      };
      if (stableJson(record) !== stableJson(expectedRecord)) {
        throw new BackupError('ATTACHMENT_MANIFEST_MISMATCH', `Attachment metadata mismatch for id ${row.attachment_id}`);
      }
      if (row.blob_sha256) {
        const file = filesByPath.get(expectedRecord.bundlePath);
        if (!file || file.kind !== 'issue-attachment' || file.sha256 !== row.blob_sha256
            || file.bytes !== row.blob_size_bytes) {
          throw new BackupError('ATTACHMENT_MISSING', `Archived issue attachment is absent: ${row.attachment_id}`);
        }
      }
    }
  } finally {
    validated.db.close();
  }
  return { ok: true, bundlePath: root, manifest };
}

function timestampName(now) {
  const compact = new Date(now).toISOString().replace(/[-:.]/gu, '').replace('Z', 'Z');
  return `wsb-${compact}-${crypto.randomBytes(4).toString('hex')}`;
}

class BackupService {
  constructor({
    db,
    databasePath,
    attachmentsDir,
    backupDir,
    retentionCount = 14,
    busyTimeoutMs = 5000,
    migrationsDir,
    offsiteAdapter = null,
    clock = Date.now,
    logger = console,
    copyFile = copyStableFile,
    verifyBundle = verifyBackupBundle,
    interruptedBundleAgeMs = DEFAULT_INTERRUPTED_BUNDLE_AGE_MS,
  } = {}) {
    if (!db?.backup || !databasePath || !attachmentsDir || !backupDir) {
      throw new TypeError('BackupService requires db and database/attachment/backup paths');
    }
    if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
      throw new TypeError('retentionCount must be from 1 to 365');
    }
    if (offsiteAdapter && typeof offsiteAdapter.upload !== 'function') {
      throw new TypeError('offsiteAdapter.upload is required');
    }
    if (!Number.isSafeInteger(interruptedBundleAgeMs) || interruptedBundleAgeMs < 1) {
      throw new TypeError('interruptedBundleAgeMs must be a positive safe integer');
    }
    if (typeof verifyBundle !== 'function') throw new TypeError('verifyBundle must be a function');
    this.db = db;
    this.databasePath = path.resolve(databasePath);
    this.attachmentsDir = ensurePrivateDirectory(attachmentsDir);
    this.backupDir = ensurePrivateDirectory(backupDir);
    if (isContained(this.attachmentsDir, this.backupDir, { allowRoot: true })
        || isContained(this.backupDir, this.attachmentsDir, { allowRoot: true })) {
      throw new BackupError('UNSAFE_BACKUP_LAYOUT', 'Backup and attachment directories must be separate');
    }
    this.retentionCount = retentionCount;
    this.busyTimeoutMs = busyTimeoutMs;
    this.migrationsDir = migrationsDir;
    this.offsiteAdapter = offsiteAdapter;
    this.clock = clock;
    this.logger = logger;
    this.copyFile = copyFile;
    this.verifyBundle = verifyBundle;
    this.interruptedBundleAgeMs = interruptedBundleAgeMs;
    this.lockPath = path.join(this.backupDir, BACKUP_LOCK_NAME);
    this.active = null;
    this.accepting = true;
  }

  run() {
    if (!this.accepting) return Promise.reject(new BackupError('STOPPED', 'Backup service is stopping'));
    if (this.active) return this.active;
    const operation = this._run();
    this.active = operation.finally(() => { this.active = null; });
    return this.active;
  }

  async _run() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('clock must return UTC milliseconds');
    }
    const owner = {
      runId: crypto.randomUUID(),
      pid: process.pid,
      startedAt: Date.now(),
    };
    await this._acquireLock(owner);
    try {
      return await this._runLocked(now, owner);
    } finally {
      // Filesystem exclusion is released even when DB recording, copying,
      // verification, offsite upload, or pruning throws.
      await this._releaseLock(owner);
    }
  }

  async _runLocked(now, owner) {
    const runUid = `backup:${now}:${owner.runId}`;
    let runRecorded = false;
    let tempPath;
    this.db.prepare(`INSERT INTO maintenance_runs(run_uid,operation,status,started_at)
      VALUES (?,'BACKUP','RUNNING',?)`).run(runUid, now);
    runRecorded = true;
    try {
      await this._cleanInterrupted(owner.runId);
      const bundleName = timestampName(now);
      tempPath = path.join(this.backupDir, `.tmp-${bundleName}`);
      const bundlePath = path.join(this.backupDir, bundleName);
      await fs.promises.mkdir(tempPath, { mode: 0o700 });
      await this._writeOwner(tempPath, owner);
      const databaseDestination = path.join(tempPath, DATABASE_NAME);

      // better-sqlite3 performs SQLite's online backup API and includes committed
      // WAL pages. Never copy the live database/WAL files directly.
      await this.db.backup(databaseDestination);
      sealSnapshotDatabase(databaseDestination, { busyTimeoutMs: this.busyTimeoutMs });
      if (process.platform !== 'win32') await fs.promises.chmod(databaseDestination, 0o600);
      const validated = verifySnapshotDatabase(databaseDestination, {
        busyTimeoutMs: this.busyTimeoutMs,
        migrationsDir: this.migrationsDir,
      });
      let issueAttachments;
      let schemaVersion;
      try {
        issueAttachments = listIssueAttachments(validated.db);
        schemaVersion = validated.schemaVersion;
      } finally { validated.db.close(); }

      const files = [{ path: DATABASE_NAME, kind: 'database', ...(await hashFile(databaseDestination)) }];
      const copiedBlobs = new Map();
      const attachmentsPath = path.join(tempPath, 'attachments');
      await fs.promises.mkdir(attachmentsPath, { mode: 0o700 });
      for (const row of issueAttachments) {
        if (!row.blob_sha256) continue;
        if (!row.storage_key) throw new BackupError('ATTACHMENT_MISSING', `Issue attachment ${row.attachment_id} has no storage key`);
        if (copiedBlobs.has(row.blob_sha256)) continue;
        const safeSource = assertSafeSource(this.attachmentsDir, row.storage_key);
        const source = safeSource.candidate;
        const relative = `attachments/${row.blob_sha256}`;
        const destination = path.join(tempPath, 'attachments', row.blob_sha256);
        const digest = await this.copyFile(source, destination, {
          attachment: row,
          expectedStat: safeSource.stat,
          allowedRoot: this.attachmentsDir,
        });
        if (digest.sha256 !== row.blob_sha256 || digest.bytes !== row.blob_size_bytes) {
          throw new BackupError('ATTACHMENT_HASH_MISMATCH', `Live attachment does not match database: ${row.attachment_id}`);
        }
        copiedBlobs.set(row.blob_sha256, relative);
        files.push({ path: relative, kind: 'issue-attachment', ...digest });
      }
      const attachments = issueAttachments.map((row) => ({
        attachmentId: row.attachment_id,
        attachmentUid: row.attachment_uid,
        issueId: row.issue_id,
        publicId: row.public_id,
        displayName: row.display_name,
        detectedMime: row.detected_mime,
        sizeBytes: row.size_bytes,
        processingStatus: row.processing_status,
        parseStatus: row.parse_status,
        blobSha256: row.blob_sha256,
        storageKey: row.storage_key,
        bundlePath: row.blob_sha256 ? copiedBlobs.get(row.blob_sha256) : null,
      }));
      files.sort((left, right) => left.path.localeCompare(right.path));
      const manifest = {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        createdAt: now,
        schemaVersion,
        files,
        attachments,
      };

      // The owner marker is never part of a published bundle. Durably write the
      // manifest and both directory-entry sets before the atomic rename.
      await fs.promises.unlink(path.join(tempPath, TEMP_OWNER_NAME));
      const manifestHandle = await fs.promises.open(path.join(tempPath, MANIFEST_NAME), 'wx', 0o600);
      try {
        await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
        await manifestHandle.sync();
      } finally { await manifestHandle.close(); }
      await this._fsyncDirectory(attachmentsPath);
      await this._fsyncDirectory(tempPath);

      await this.verifyBundle(tempPath, {
        busyTimeoutMs: this.busyTimeoutMs,
        migrationsDir: this.migrationsDir,
      });
      await fs.promises.rename(tempPath, bundlePath);
      tempPath = null;
      await this._fsyncDirectory(this.backupDir);

      let publishedCheck;
      try {
        publishedCheck = await this.verifyBundle(bundlePath, {
          busyTimeoutMs: this.busyTimeoutMs,
          migrationsDir: this.migrationsDir,
        });
      } catch (error) {
        await this._discardPublished(bundlePath);
        throw new BackupError(
          'POST_PUBLISH_VERIFY_FAILED',
          `Published backup failed verification; older backups were not pruned: ${error.message}`,
          { cause: error }
        );
      }
      const pruned = await this._prune(bundlePath, publishedCheck);

      let offsite = { status: 'DISABLED' };
      if (this.offsiteAdapter) {
        const offsiteUid = `offsite:${now}:${crypto.randomUUID()}`;
        this.db.prepare(`INSERT INTO maintenance_runs(run_uid,operation,status,started_at,artifact_name)
          VALUES (?,'OFFSITE','RUNNING',?,?)`).run(offsiteUid, now, bundleName);
        try {
          const value = await this.offsiteAdapter.upload({ bundlePath, bundleName, manifest });
          offsite = { status: 'SUCCEEDED', value: value || null };
          this.db.prepare(`UPDATE maintenance_runs SET status='SUCCEEDED',completed_at=?,details_json=?
            WHERE run_uid=?`).run(Math.max(now, this.clock()), JSON.stringify(offsite), offsiteUid);
        } catch (error) {
          offsite = { status: 'FAILED', code: error.code || 'OFFSITE_FAILED' };
          this.logger.error?.(`Offsite backup failed; local bundle retained: ${error.message}`);
          this.db.prepare(`UPDATE maintenance_runs SET status='FAILED',completed_at=?,error_code=?,error_message=?
            WHERE run_uid=?`).run(Math.max(now, this.clock()), offsite.code, String(error.message).slice(0, 2000), offsiteUid);
        }
      }
      const result = { bundlePath, bundleName, manifest, pruned, offsite };
      this.db.prepare(`UPDATE maintenance_runs SET status='SUCCEEDED',completed_at=?,artifact_name=?,details_json=?
        WHERE run_uid=?`).run(Math.max(now, this.clock()), bundleName,
        JSON.stringify({ bundleName, pruned, offsite }), runUid);
      return result;
    } catch (error) {
      if (tempPath) await fs.promises.rm(tempPath, { recursive: true, force: true }).catch(() => {});
      if (runRecorded) {
        this.db.prepare(`UPDATE maintenance_runs SET status='FAILED',completed_at=?,error_code=?,error_message=?
          WHERE run_uid=?`).run(Math.max(now, this.clock()), error.code || 'BACKUP_FAILED',
          String(error.message).slice(0, 2000), runUid);
      }
      throw error;
    }
  }

  async _writeOwner(directory, owner) {
    const handle = await fs.promises.open(path.join(directory, TEMP_OWNER_NAME), 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await this._fsyncDirectory(directory);
  }

  async _readOwner(directory) {
    try {
      const value = JSON.parse(await fs.promises.readFile(path.join(directory, TEMP_OWNER_NAME), 'utf8'));
      if (typeof value?.runId !== 'string' || !Number.isSafeInteger(value.pid)
          || value.pid < 1 || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0) return null;
      return value;
    } catch { return null; }
  }

  _processIsLive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  }

  async _acquireLock(owner) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.promises.mkdir(this.lockPath, { mode: 0o700 });
        try {
          await this._writeOwner(this.lockPath, owner);
          await this._fsyncDirectory(this.backupDir);
          return;
        } catch (error) {
          await fs.promises.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.promises.lstat(this.lockPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new BackupError('UNSAFE_BACKUP_LOCK', 'Backup lock is not a real directory');
        }
        const existing = await this._readOwner(this.lockPath);
        const newest = Math.max(stat.mtimeMs, existing?.startedAt || 0);
        const oldEnough = Date.now() - newest >= this.interruptedBundleAgeMs;
        if ((existing && this._processIsLive(existing.pid)) || !oldEnough) {
          throw new BackupError('BACKUP_LOCKED', 'Another backup run owns the filesystem lock');
        }
        const stale = path.join(this.backupDir, `.stale-backup-lock-${crypto.randomUUID()}`);
        try {
          await fs.promises.rename(this.lockPath, stale);
        } catch (renameError) {
          if (renameError.code === 'ENOENT') continue;
          throw renameError;
        }
        await this._fsyncDirectory(this.backupDir);
        await fs.promises.rm(stale, { recursive: true, force: true });
      }
    }
    throw new BackupError('BACKUP_LOCKED', 'Could not acquire backup filesystem lock');
  }

  async _releaseLock(owner) {
    let stat;
    try { stat = await fs.promises.lstat(this.lockPath); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new BackupError('UNSAFE_BACKUP_LOCK', 'Backup lock changed while owned');
    }
    const current = await this._readOwner(this.lockPath);
    if (current && current.runId !== owner.runId) {
      throw new BackupError('BACKUP_LOCK_OWNERSHIP_LOST', 'Backup lock owner changed unexpectedly');
    }
    await fs.promises.rm(this.lockPath, { recursive: true, force: true });
    await this._fsyncDirectory(this.backupDir);
  }

  async _cleanInterrupted(currentRunId) {
    for (const entry of await fs.promises.readdir(this.backupDir, { withFileTypes: true })) {
      if (!entry.name.startsWith('.tmp-wsb-')) continue;
      const candidate = path.join(this.backupDir, entry.name);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink()) throw new BackupError('UNSAFE_TEMP_BUNDLE', 'Interrupted bundle is a symlink');
      const owner = stat.isDirectory() ? await this._readOwner(candidate) : null;
      if (owner?.runId === currentRunId || (owner && this._processIsLive(owner.pid))) continue;
      const newest = Math.max(stat.mtimeMs, owner?.startedAt || 0);
      if (Date.now() - newest < this.interruptedBundleAgeMs) continue;
      await fs.promises.rm(candidate, { recursive: true, force: true });
    }
  }

  async _discardPublished(bundlePath) {
    const quarantine = path.join(
      this.backupDir,
      `.failed-${path.basename(bundlePath)}-${crypto.randomUUID()}`
    );
    try {
      await fs.promises.rename(bundlePath, quarantine);
      await this._fsyncDirectory(this.backupDir);
      await fs.promises.rm(quarantine, { recursive: true, force: true });
    } catch (error) {
      await fs.promises.rm(bundlePath, { recursive: true, force: true });
      await this._fsyncDirectory(this.backupDir);
      if (fs.existsSync(bundlePath)) throw error;
    }
  }

  async _prune(newBundlePath, newBundleCheck) {
    const verified = [{
      path: newBundlePath,
      createdAt: newBundleCheck.manifest.createdAt,
      name: path.basename(newBundlePath),
    }];
    for (const entry of await fs.promises.readdir(this.backupDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !BUNDLE_NAME.test(entry.name)) continue;
      const candidate = path.join(this.backupDir, entry.name);
      if (candidate === newBundlePath) continue;
      try {
        const check = await this.verifyBundle(candidate, {
          busyTimeoutMs: this.busyTimeoutMs,
          migrationsDir: this.migrationsDir,
        });
        verified.push({ path: candidate, createdAt: check.manifest.createdAt, name: entry.name });
      } catch (error) {
        this.logger.warn?.(`Retaining unverifiable backup ${entry.name}: ${error.message}`);
      }
    }
    verified.sort((left, right) => right.createdAt - left.createdAt || right.name.localeCompare(left.name));
    const removable = verified.slice(this.retentionCount).filter((item) => item.path !== newBundlePath);
    // Because the newly published bundle was verified after rename and is
    // excluded from removal, pruning can never reduce the good-bundle floor.
    for (const item of removable) await fs.promises.rm(item.path, { recursive: true });
    return removable.map((item) => item.name);
  }

  async _fsyncDirectory(directory) {
    let handle;
    try {
      handle = await fs.promises.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
    } finally { await handle?.close().catch(() => {}); }
  }

  stop() { this.accepting = false; }
  async drain() {
    if (this.active) await this.active;
    return { drained: true };
  }
}

module.exports = {
  BUNDLE_FORMAT,
  BUNDLE_NAME,
  BUNDLE_VERSION,
  DATABASE_NAME,
  MANIFEST_NAME,
  BackupError,
  BackupService,
  assertRelativeManifestPath,
  copyStableFile,
  ensurePrivateDirectory,
  hashFile,
  isContained,
  manifestIdentity,
  sealSnapshotDatabase,
  verifyBackupBundle,
  verifySnapshotDatabase,
};
