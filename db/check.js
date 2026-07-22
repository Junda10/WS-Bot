'use strict';

const { assertProductionPragmas } = require('./connection');
const { DEFAULT_MIGRATIONS_DIR, loadMigrations, readMigrationState } = require('./migrate');

function checkIntegrity(db) {
  const rows = db.pragma('integrity_check');
  const messages = rows.map((row) => row.integrity_check);
  return {
    ok: messages.length === 1 && messages[0] === 'ok',
    messages,
  };
}

function checkForeignKeys(db) {
  const violations = db.pragma('foreign_key_check');
  return { ok: violations.length === 0, violations };
}

function checkDatabase(db, options = {}) {
  const migrations = loadMigrations(options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
  const pragmas = assertProductionPragmas(db, options.busyTimeoutMs ?? 5000);

  const integrity = checkIntegrity(db);
  if (!integrity.ok) {
    throw new Error(`SQLite integrity_check failed: ${integrity.messages.join('; ')}`);
  }

  const migrationState = readMigrationState(db, migrations, { requireCurrent: true });
  const foreignKeys = checkForeignKeys(db);
  if (!foreignKeys.ok) {
    const details = foreignKeys.violations
      .map((row) => `${row.table}(rowid=${row.rowid}) -> ${row.parent}`)
      .join('; ');
    throw new Error(`SQLite foreign_key_check failed: ${details}`);
  }

  return { pragmas, integrity, foreignKeys, currentVersion: migrationState.currentVersion };
}

module.exports = { checkIntegrity, checkForeignKeys, checkDatabase };
