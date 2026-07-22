'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MANIFEST_NAME,
  BackupError,
  copyStableFile,
  ensurePrivateDirectory,
  verifyBackupBundle,
} = require('./backup-service');

async function preflightTemporarySpace(directory, requiredBytes, statfs = fs.promises.statfs) {
  if (typeof statfs !== 'function') return { checked: false, requiredBytes };
  let stats;
  try {
    stats = await statfs(directory, { bigint: true });
  } catch (error) {
    if (['ENOSYS', 'ENOTSUP'].includes(error.code)) return { checked: false, requiredBytes };
    throw new BackupError('TEMP_SPACE_CHECK_FAILED', `Could not check restore temporary free space: ${error.message}`, {
      cause: error,
    });
  }
  const blockSize = BigInt(stats.bsize);
  const available = BigInt(stats.bavail) * blockSize;
  if (available < requiredBytes) {
    throw new BackupError(
      'INSUFFICIENT_TEMP_SPACE',
      `Restore check requires ${requiredBytes} temporary bytes but only ${available} are available`
    );
  }
  return { checked: true, requiredBytes, availableBytes: available };
}

async function restoreCheck(bundlePath, options = {}) {
  const source = path.resolve(bundlePath);
  // Validate containment, schema, unknown entries, and every source hash before
  // staging. Then validate again from an isolated restore area.
  const sourceCheck = await verifyBackupBundle(source, options);
  const tempParent = ensurePrivateDirectory(options.tempDir || os.tmpdir());
  const manifestBytes = BigInt((await fs.promises.stat(path.join(source, MANIFEST_NAME))).size);
  const requiredBytes = sourceCheck.manifest.files.reduce(
    (total, file) => total + BigInt(file.bytes),
    manifestBytes
  );
  await preflightTemporarySpace(tempParent, requiredBytes, options.statfs);
  const restoreArea = await fs.promises.mkdtemp(path.join(tempParent, 'wsb-restore-check-'));
  if (process.platform !== 'win32') await fs.promises.chmod(restoreArea, 0o700);
  try {
    const paths = [...sourceCheck.manifest.files.map((file) => file.path), MANIFEST_NAME];
    for (const relative of paths) {
      const from = path.join(source, ...relative.split('/'));
      const to = path.join(restoreArea, ...relative.split('/'));
      await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await copyStableFile(from, to);
    }
    const restored = await verifyBackupBundle(restoreArea, options);
    return {
      ok: true,
      bundlePath: source,
      schemaVersion: restored.manifest.schemaVersion,
      createdAt: restored.manifest.createdAt,
      fileCount: restored.manifest.files.length,
      attachmentCount: restored.manifest.attachments.length,
    };
  } finally {
    await fs.promises.rm(restoreArea, { recursive: true, force: true });
  }
}

module.exports = { preflightTemporarySpace, restoreCheck };
