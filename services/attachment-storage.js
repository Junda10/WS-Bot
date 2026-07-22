'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class AttachmentStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AttachmentStorageError';
    this.code = code;
    this.retryable = options.retryable !== false;
    this.destination = options.destination || null;
    this.destinationStorageKey = options.destinationStorageKey || null;
    this.cleanupError = options.cleanupError || null;
    this.requiresReconciliation = options.requiresReconciliation === true;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function safeExtension(value) {
  const extension = String(value || '').toLowerCase();
  if (!/^[a-z0-9]{1,16}$/u.test(extension)) throw new TypeError('storage extension is invalid');
  return extension;
}

function ensurePrivateDirectory(directory, fsImpl) {
  const resolved = path.resolve(directory);
  fsImpl.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stats = fsImpl.lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AttachmentStorageError('UNSAFE_STORAGE_ROOT', `${resolved} must be a real directory`, {
      retryable: false,
    });
  }
  if (process.platform !== 'win32') fsImpl.chmodSync(resolved, 0o700);
  return fsImpl.realpathSync(resolved);
}

class AttachmentStorage {
  constructor(options = {}) {
    if (!options.rootDir || !path.isAbsolute(options.rootDir)) {
      throw new TypeError('AttachmentStorage rootDir must be absolute');
    }
    if (!options.tempDir || !path.isAbsolute(options.tempDir)) {
      throw new TypeError('AttachmentStorage tempDir must be absolute');
    }
    this.fs = options.fs || fs;
    this.promises = options.promises || this.fs.promises;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.rootDir = ensurePrivateDirectory(options.rootDir, this.fs);
    this.tempDir = ensurePrivateDirectory(options.tempDir, this.fs);
    if (this.rootDir === this.tempDir || isInside(this.rootDir, this.tempDir)
        || isInside(this.tempDir, this.rootDir)) {
      throw new AttachmentStorageError(
        'UNSAFE_STORAGE_LAYOUT',
        'Attachment archive and staging directories must be distinct siblings',
        { retryable: false }
      );
    }
    if (this.fs.statSync(this.rootDir).dev !== this.fs.statSync(this.tempDir).dev) {
      throw new AttachmentStorageError(
        'NON_ATOMIC_STORAGE_LAYOUT',
        'Attachment staging and archive directories must be on the same filesystem',
        { retryable: false }
      );
    }
  }

  _assertCurrentRoot(root, configured, label) {
    let real;
    try {
      const stats = this.fs.lstatSync(configured);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('not a real directory');
      real = this.fs.realpathSync(configured);
    } catch (error) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', `${label} is unavailable or unsafe`, {
        cause: error,
        retryable: false,
      });
    }
    if (real !== root) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', `${label} canonical path changed`, {
        retryable: false,
      });
    }
  }

  _assertSafeComponents(root, candidate, options = {}) {
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Path escapes its private root', {
        retryable: false,
      });
    }
    const parts = relative.split(path.sep);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      let stats;
      try {
        stats = this.fs.lstatSync(current);
      } catch (error) {
        if (error?.code === 'ENOENT' && options.allowMissing) return current;
        throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Storage path is inaccessible', {
          cause: error,
          retryable: false,
        });
      }
      if (stats.isSymbolicLink()) {
        throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Storage path contains a symlink', {
          retryable: false,
        });
      }
      const leaf = index === parts.length - 1;
      if (!leaf && !stats.isDirectory()) {
        throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Storage parent is not a directory', {
          retryable: false,
        });
      }
      if (leaf && options.requireFile && !stats.isFile()) {
        throw new AttachmentStorageError('ARCHIVE_MISSING', 'Archived attachment is not a regular file');
      }
    }
    return candidate;
  }

  _safeStoragePath(storageKey, { mustExist = false, allowMissing = false } = {}) {
    if (typeof storageKey !== 'string' || !storageKey || storageKey.includes('\0')
        || path.isAbsolute(storageKey)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_KEY', 'Storage key is invalid', {
        retryable: false,
      });
    }
    this._assertCurrentRoot(this.rootDir, this.rootDir, 'attachment root');
    const candidate = path.resolve(this.rootDir, storageKey);
    if (!isInside(this.rootDir, candidate)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_KEY', 'Storage key escapes the private root', {
        retryable: false,
      });
    }
    try {
      this._assertSafeComponents(this.rootDir, candidate, {
        allowMissing: allowMissing && !mustExist,
        requireFile: mustExist,
      });
      if (mustExist) {
        const real = this.fs.realpathSync(candidate);
        if (!isInside(this.rootDir, real) || real !== candidate) {
          throw new AttachmentStorageError('UNSAFE_STORAGE_KEY', 'Storage path is not canonical', {
            retryable: false,
          });
        }
      }
      return candidate;
    } catch (error) {
      if (error instanceof AttachmentStorageError) throw error;
      throw new AttachmentStorageError('ARCHIVE_MISSING', 'Archived attachment is missing or unsafe', {
        cause: error,
      });
    }
  }

  resolve(storageKey) {
    return this._safeStoragePath(storageKey, { mustExist: true });
  }

  async stageBuffer(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('stageBuffer requires a Buffer');
    if (Number.isSafeInteger(options.maxBytes) && buffer.length > options.maxBytes) {
      throw new AttachmentStorageError('FILE_TOO_LARGE', 'Attachment exceeds the configured byte limit', {
        retryable: false,
      });
    }
    this._assertCurrentRoot(this.tempDir, this.tempDir, 'attachment staging root');
    const stagePath = path.join(this.tempDir, `${this.randomUUID()}.part`);
    if (!isInside(this.tempDir, stagePath)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Generated staging path is unsafe', {
        retryable: false,
      });
    }
    let handle;
    try {
      handle = await this.promises.open(stagePath, 'wx', 0o600);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close();
      handle = null;
      if (process.platform !== 'win32') await this.promises.chmod(stagePath, 0o600);
      const real = await this.promises.realpath(stagePath);
      if (!isInside(this.tempDir, real)) throw new Error('staging path escaped root');
      return Object.freeze({ path: real, sizeBytes: buffer.length });
    } catch (error) {
      try { await handle?.close(); } catch {}
      try { await this.promises.unlink(stagePath); } catch {}
      throw new AttachmentStorageError('DISK_WRITE_FAILED', 'Could not write attachment staging file', {
        cause: error,
      });
    }
  }

  async discard(stage) {
    if (!stage?.path || !isInside(this.tempDir, path.resolve(stage.path))) return false;
    const stagePath = path.resolve(stage.path);
    this._assertCurrentRoot(this.tempDir, this.tempDir, 'attachment staging root');
    this._assertSafeComponents(this.tempDir, stagePath, { allowMissing: true });
    try {
      await this.promises.unlink(stagePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new AttachmentStorageError('DISK_CLEANUP_FAILED', 'Could not remove attachment staging file', {
        cause: error,
      });
    }
  }

  async _ensureArchiveDirectory(relativeDirectory) {
    this._assertCurrentRoot(this.rootDir, this.rootDir, 'attachment root');
    const directory = path.resolve(this.rootDir, relativeDirectory);
    if (!isInside(this.rootDir, directory)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Generated archive path is unsafe', {
        retryable: false,
      });
    }
    this._assertSafeComponents(this.rootDir, directory, { allowMissing: true });
    await this.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    this._assertSafeComponents(this.rootDir, directory);
    const stats = await this.promises.lstat(directory);
    const real = await this.promises.realpath(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || real !== directory
        || !isInside(this.rootDir, real)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Archive directory is unsafe', {
        retryable: false,
      });
    }
    if (process.platform !== 'win32') await this.promises.chmod(real, 0o700);
    return real;
  }

  async commitStaged(stage, options = {}) {
    if (!stage?.path || !isInside(this.tempDir, path.resolve(stage.path))) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Staging descriptor is invalid', {
        retryable: false,
      });
    }
    const stagePath = path.resolve(stage.path);
    this._assertCurrentRoot(this.tempDir, this.tempDir, 'attachment staging root');
    this._assertSafeComponents(this.tempDir, stagePath, { requireFile: true });
    const extension = safeExtension(options.extension);
    const hash = String(options.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new TypeError('sha256 must be lowercase hex');
    const issueId = options.issueId;
    const directoryKey = issueId == null
      ? path.join('temporary', hash.slice(0, 2))
      : path.join('issues', String(issueId));
    if (issueId != null && (!Number.isSafeInteger(issueId) || issueId < 1)) {
      throw new TypeError('issueId must be a positive safe integer');
    }
    const directory = await this._ensureArchiveDirectory(directoryKey);
    const fileName = `${hash}-${this.randomUUID()}.${extension}`;
    const destination = path.join(directory, fileName);
    if (!isInside(this.rootDir, destination)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Generated archive file path is unsafe', {
        retryable: false,
      });
    }
    let renamed = false;
    try {
      await this.promises.rename(stagePath, destination);
      renamed = true;
      if (process.platform !== 'win32') await this.promises.chmod(destination, 0o600);
      const fileHandle = await this.promises.open(destination, 'r');
      try { await fileHandle.sync(); } finally { await fileHandle.close(); }
      const directoryHandle = await this.promises.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      return Object.freeze({
        path: destination,
        storageKey: path.relative(this.rootDir, destination),
      });
    } catch (error) {
      let cleanupError = null;
      if (renamed) {
        try { await this.promises.unlink(destination); } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') cleanupError = unlinkError;
        }
      }
      throw new AttachmentStorageError('ATOMIC_ARCHIVE_FAILED', 'Could not atomically archive attachment', {
        cause: error,
        destination: renamed ? destination : null,
        destinationStorageKey: renamed ? path.relative(this.rootDir, destination) : null,
        cleanupError,
        requiresReconciliation: Boolean(renamed && cleanupError),
      });
    }
  }

  async remove(storageKey) {
    const filePath = this._safeStoragePath(storageKey, { allowMissing: true });
    try {
      await this.promises.unlink(filePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new AttachmentStorageError('DISK_CLEANUP_FAILED', 'Could not remove archived attachment', {
        cause: error,
      });
    }
  }

  async promotionTarget(storageKey, issueId) {
    if (!Number.isSafeInteger(issueId) || issueId < 1) {
      throw new TypeError('issueId must be a positive safe integer');
    }
    const source = this._safeStoragePath(storageKey, { allowMissing: true });
    const targetDirectory = await this._ensureArchiveDirectory(path.join('issues', String(issueId)));
    const target = path.join(targetDirectory, path.basename(source));
    if (!isInside(this.rootDir, target)) {
      throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Promotion target is unsafe', {
        retryable: false,
      });
    }
    return path.relative(this.rootDir, target);
  }

  async reconcilePromotion(storageKey, targetStorageKey) {
    const source = this._safeStoragePath(storageKey, { allowMissing: true });
    const target = this._safeStoragePath(targetStorageKey, { allowMissing: true });
    const sourceExists = this.fs.existsSync(source);
    const targetExists = this.fs.existsSync(target);
    if (sourceExists && targetExists) {
      throw new AttachmentStorageError(
        'PROMOTION_AMBIGUOUS',
        'Both promotion source and destination exist; refusing to choose canonical bytes',
        { retryable: false, destination: target, destinationStorageKey: targetStorageKey }
      );
    }
    if (!sourceExists && !targetExists) {
      throw new AttachmentStorageError('ARCHIVE_MISSING', 'Promotion source and destination are both missing');
    }
    if (targetExists) {
      this._assertSafeComponents(this.rootDir, target, { requireFile: true });
      return Object.freeze({ moved: false, storageKey: targetStorageKey, path: target });
    }
    this._assertSafeComponents(this.rootDir, source, { requireFile: true });
    try {
      await this.promises.rename(source, target);
      if (process.platform !== 'win32') await this.promises.chmod(target, 0o600);
      const targetDirectory = path.dirname(target);
      const directoryHandle = await this.promises.open(targetDirectory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      return Object.freeze({ moved: true, storageKey: targetStorageKey, path: target });
    } catch (error) {
      // Never roll a successful rename back. The durable promotion intent lets
      // startup distinguish this destination from an orphan after any crash or
      // post-rename fsync/chmod failure.
      throw new AttachmentStorageError('ATOMIC_PROMOTION_FAILED', 'Could not promote attachment to issue archive', {
        cause: error,
        destination: target,
        destinationStorageKey: targetStorageKey,
        requiresReconciliation: !this.fs.existsSync(source) && this.fs.existsSync(target),
      });
    }
  }

  async promote(storageKey, issueId) {
    const targetStorageKey = await this.promotionTarget(storageKey, issueId);
    return this.reconcilePromotion(storageKey, targetStorageKey);
  }

  async listStorageKeys() {
    this._assertCurrentRoot(this.rootDir, this.rootDir, 'attachment root');
    const keys = [];
    const visit = async (directory) => {
      this._assertSafeComponents(this.rootDir, directory);
      const entries = await this.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        const stats = await this.promises.lstat(candidate);
        if (stats.isSymbolicLink()) {
          throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Archive contains a symlink', {
            retryable: false,
          });
        }
        if (stats.isDirectory()) await visit(candidate);
        else if (stats.isFile()) keys.push(path.relative(this.rootDir, candidate));
      }
    };
    for (const top of await this.promises.readdir(this.rootDir, { withFileTypes: true })) {
      const candidate = path.join(this.rootDir, top.name);
      const stats = await this.promises.lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new AttachmentStorageError('UNSAFE_STORAGE_PATH', 'Archive contains a symlink', {
          retryable: false,
        });
      }
      if (stats.isDirectory()) await visit(candidate);
      else if (stats.isFile()) keys.push(path.relative(this.rootDir, candidate));
    }
    return keys;
  }

  async cleanupOrphans(liveStorageKeys, options = {}) {
    const live = new Set([...liveStorageKeys].map((key) => String(key)));
    const logger = options.logger || console;
    const removed = [];
    const quarantined = [];
    const errors = [];
    this._assertCurrentRoot(this.rootDir, this.rootDir, 'attachment root');
    this._assertCurrentRoot(this.tempDir, this.tempDir, 'attachment staging root');
    const quarantineDirectory = path.join(this.tempDir, 'quarantine');
    this._assertSafeComponents(this.tempDir, quarantineDirectory, { allowMissing: true });
    await this.promises.mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
    this._assertSafeComponents(this.tempDir, quarantineDirectory);

    const report = (candidate, error) => {
      const item = { path: candidate, code: error?.code || 'ORPHAN_CLEANUP_FAILED', message: error?.message || String(error) };
      errors.push(item);
      logger.error?.(`Attachment orphan cleanup failed for ${candidate}: ${item.message}`);
    };
    const quarantine = async (candidate, reason) => {
      const target = path.join(quarantineDirectory, `${this.randomUUID()}.${reason}`);
      try {
        await this.promises.rename(candidate, target);
        const key = path.relative(this.rootDir, candidate);
        quarantined.push(key);
        logger.warn?.(`Quarantined unsafe attachment archive entry: ${key}`);
      } catch (error) {
        report(candidate, error);
      }
    };
    const visit = async (directory) => {
      let entries;
      try { entries = await this.promises.readdir(directory, { withFileTypes: true }); } catch (error) {
        report(directory, error);
        return;
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        let stats;
        try { stats = await this.promises.lstat(candidate); } catch (error) {
          report(candidate, error);
          continue;
        }
        if (stats.isSymbolicLink()) {
          await quarantine(candidate, 'symlink');
          continue;
        }
        if (stats.isDirectory()) {
          await visit(candidate);
          continue;
        }
        if (!stats.isFile()) {
          await quarantine(candidate, 'special');
          continue;
        }
        const key = path.relative(this.rootDir, candidate);
        if (live.has(key)) continue;
        try {
          if (await this.remove(key)) removed.push(key);
        } catch (error) {
          report(candidate, error);
        }
      }
    };
    await visit(this.rootDir);
    return { removed, quarantined, errors };
  }

  async removeOrphans(liveStorageKeys, options = {}) {
    return (await this.cleanupOrphans(liveStorageKeys, options)).removed;
  }
}

module.exports = { AttachmentStorage, AttachmentStorageError, isInside };
