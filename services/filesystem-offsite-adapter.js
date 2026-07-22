'use strict';

const fs = require('fs');
const path = require('path');
const {
  BUNDLE_NAME,
  MANIFEST_NAME,
  BackupError,
  copyStableFile,
  ensurePrivateDirectory,
  isContained,
  manifestIdentity,
  verifyBackupBundle,
} = require('./backup-service');

class FilesystemOffsiteAdapter {
  constructor({ destinationDir, busyTimeoutMs = 5000, migrationsDir } = {}) {
    if (!destinationDir || !path.isAbsolute(destinationDir)) {
      throw new TypeError('filesystem offsite destinationDir must be absolute');
    }
    this.destinationDir = ensurePrivateDirectory(destinationDir);
    this.busyTimeoutMs = busyTimeoutMs;
    this.migrationsDir = migrationsDir;
  }

  async upload({ bundlePath, bundleName }) {
    if (typeof bundleName !== 'string' || !BUNDLE_NAME.test(bundleName)
        || path.basename(path.resolve(bundlePath)) !== bundleName) {
      throw new BackupError('INVALID_BUNDLE_NAME', 'Offsite bundle name is not canonical');
    }
    const source = path.resolve(bundlePath);
    const sourceCanonical = await fs.promises.realpath(source);
    const destination = path.join(this.destinationDir, bundleName);
    const temporary = path.join(this.destinationDir, `.tmp-${bundleName}`);
    if (isContained(this.destinationDir, sourceCanonical, { allowRoot: true })
        || isContained(sourceCanonical, this.destinationDir, { allowRoot: true })) {
      throw new BackupError('UNSAFE_OFFSITE_LAYOUT', 'Offsite source and destination must not contain each other');
    }
    const sourceCheck = await verifyBackupBundle(sourceCanonical, {
      busyTimeoutMs: this.busyTimeoutMs,
      migrationsDir: this.migrationsDir,
    });
    if (fs.existsSync(destination)) {
      const existing = await verifyBackupBundle(destination, {
        busyTimeoutMs: this.busyTimeoutMs,
        migrationsDir: this.migrationsDir,
      });
      if (manifestIdentity(existing.manifest) !== manifestIdentity(sourceCheck.manifest)) {
        throw new BackupError('OFFSITE_NAME_CONFLICT', 'Existing offsite bundle has different contents');
      }
      return { destination, alreadyPresent: true };
    }
    if (fs.existsSync(temporary)) {
      const stat = await fs.promises.lstat(temporary);
      if (stat.isSymbolicLink()) throw new BackupError('UNSAFE_OFFSITE_TEMP', 'Offsite temp is a symlink');
      await fs.promises.rm(temporary, { recursive: true, force: true });
    }
    await fs.promises.mkdir(temporary, { mode: 0o700 });
    try {
      for (const file of [...sourceCheck.manifest.files.map((entry) => entry.path), MANIFEST_NAME]) {
        const sourceFile = path.join(sourceCanonical, ...file.split('/'));
        const destinationFile = path.join(temporary, ...file.split('/'));
        await fs.promises.mkdir(path.dirname(destinationFile), { recursive: true, mode: 0o700 });
        await copyStableFile(sourceFile, destinationFile);
      }
      await verifyBackupBundle(temporary, {
        busyTimeoutMs: this.busyTimeoutMs,
        migrationsDir: this.migrationsDir,
      });
      await fs.promises.rename(temporary, destination);
      return { destination, alreadyPresent: false };
    } catch (error) {
      await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { FilesystemOffsiteAdapter };
