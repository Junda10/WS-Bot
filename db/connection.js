'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const EXPECTED_SYNCHRONOUS = 1; // SQLite NORMAL
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

let singleton = null;
let singletonFilename = null;

function normalizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    throw new TypeError('A SQLite filename is required');
  }
  return filename === ':memory:' ? filename : path.resolve(filename);
}

function assertRegularDatabaseFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile()) {
    throw new Error(`SQLite path must be a regular file: ${filename}`);
  }
}

function enforcePrivateMode(target, mode, description) {
  if (process.platform === 'win32') return;

  const stat = fs.statSync(target);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${description} must be owned by the current user: ${target}`);
  }
  fs.chmodSync(target, mode);
}

function prepareDatabasePath(filename, fileMustExist) {
  const directory = path.dirname(filename);

  if (fileMustExist) {
    if (!fs.existsSync(filename)) {
      throw new Error(`SQLite database does not exist: ${filename}`);
    }
    assertRegularDatabaseFile(filename);
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (!fs.existsSync(filename)) {
      let descriptor;
      try {
        descriptor = fs.openSync(filename, 'wx', PRIVATE_FILE_MODE);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }
    assertRegularDatabaseFile(filename);
  }

  enforcePrivateMode(directory, PRIVATE_DIRECTORY_MODE, 'SQLite directory');
  enforcePrivateMode(filename, PRIVATE_FILE_MODE, 'SQLite database');
}

function getPragmaStatus(db) {
  return {
    foreignKeys: db.pragma('foreign_keys', { simple: true }),
    journalMode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
    busyTimeoutMs: db.pragma('busy_timeout', { simple: true }),
    synchronous: db.pragma('synchronous', { simple: true }),
  };
}

function assertProductionPragmas(db, expectedBusyTimeoutMs, { requireWal = true } = {}) {
  const status = getPragmaStatus(db);
  const expectedJournalMode = requireWal ? 'wal' : 'memory';
  const problems = [];

  if (status.foreignKeys !== 1) problems.push(`foreign_keys=${status.foreignKeys}, expected 1`);
  if (status.journalMode !== expectedJournalMode) {
    problems.push(`journal_mode=${status.journalMode}, expected ${expectedJournalMode}`);
  }
  if (status.busyTimeoutMs !== expectedBusyTimeoutMs) {
    problems.push(`busy_timeout=${status.busyTimeoutMs}, expected ${expectedBusyTimeoutMs}`);
  }
  if (status.synchronous !== EXPECTED_SYNCHRONOUS) {
    problems.push(`synchronous=${status.synchronous}, expected ${EXPECTED_SYNCHRONOUS} (NORMAL)`);
  }

  if (problems.length) {
    throw new Error(`SQLite PRAGMA verification failed: ${problems.join('; ')}`);
  }
  return status;
}

function configureConnection(db, busyTimeoutMs, { requireWal = true } = {}) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 120000) {
    throw new RangeError('busyTimeoutMs must be an integer from 0 to 120000');
  }

  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return assertProductionPragmas(db, busyTimeoutMs, { requireWal });
}

function getDatabase(options = {}) {
  const filename = normalizeFilename(options.filename || options.path);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  const fileMustExist = options.fileMustExist === true;

  if (singleton?.open) {
    if (singletonFilename !== filename) {
      throw new Error(`SQLite singleton is already open for ${singletonFilename}`);
    }
    return singleton;
  }

  if (filename !== ':memory:') prepareDatabasePath(filename, fileMustExist);

  const db = new Database(filename, {
    timeout: busyTimeoutMs,
    fileMustExist: filename === ':memory:' ? false : true,
  });
  try {
    configureConnection(db, busyTimeoutMs, { requireWal: filename !== ':memory:' });
    if (filename !== ':memory:') {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${filename}${suffix}`;
        if (fs.existsSync(sidecar)) enforcePrivateMode(sidecar, PRIVATE_FILE_MODE, 'SQLite sidecar');
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  singleton = db;
  singletonFilename = filename;
  return db;
}

function closeDatabase(db = singleton) {
  if (!db) return;
  if (db.open) db.close();
  if (db === singleton) {
    singleton = null;
    singletonFilename = null;
  }
}

module.exports = {
  EXPECTED_SYNCHRONOUS,
  getDatabase,
  closeDatabase,
  getPragmaStatus,
  assertProductionPragmas,
};
