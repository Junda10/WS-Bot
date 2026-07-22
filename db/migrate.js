'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Exactly three digits plus lowercase snake_case keeps discovery and validation identical.
const MIGRATION_NAME = /^(\d{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const TRANSACTION_CONTROL = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

function tokenizeSql(sql) {
  const tokens = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '[') {
      index += 1;
      while (index < sql.length && sql[index] !== ']') index += 1;
      if (sql[index] === ']') index += 1;
      continue;
    }
    if (char === ';') {
      tokens.push(';');
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      tokens.push(sql.slice(index, end).toUpperCase());
      index = end;
      continue;
    }

    index += 1;
  }

  return tokens;
}

function findStatementEnd(tokens, start) {
  const first = tokens[start];
  if (first !== 'CREATE') {
    const semicolon = tokens.indexOf(';', start);
    return semicolon === -1 ? tokens.length : semicolon + 1;
  }

  let triggerSeen = false;
  let triggerBodySeen = false;
  let caseDepth = 0;
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!triggerSeen) {
      if (token === 'TRIGGER') triggerSeen = true;
      if (token === ';') return index + 1;
      continue;
    }

    if (!triggerBodySeen) {
      if (token === 'CASE') caseDepth += 1;
      if (token === 'END' && caseDepth > 0) caseDepth -= 1;
      if (token === 'BEGIN' && caseDepth === 0) triggerBodySeen = true;
      if (token === ';') return index + 1;
      continue;
    }

    if (token === 'CASE') {
      caseDepth += 1;
    } else if (token === 'END') {
      if (caseDepth > 0) {
        caseDepth -= 1;
      } else if (tokens[index + 1] === ';') {
        return index + 2;
      }
    }
  }

  return tokens.length;
}

function assertNoTransactionControl(sql, filename = 'migration') {
  const tokens = tokenizeSql(sql);
  let index = 0;

  while (index < tokens.length) {
    while (tokens[index] === ';') index += 1;
    if (index >= tokens.length) break;

    if (TRANSACTION_CONTROL.has(tokens[index])) {
      throw new Error(
        `Migration ${filename} contains forbidden transaction-control statement: ${tokens[index]}`
      );
    }
    index = findStatementEnd(tokens, index);
  }
}

function loadMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const candidates = entries.filter((entry) => /\.sql$/i.test(entry.name));
  if (candidates.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  const migrations = candidates.map((entry) => {
    if (!entry.isFile()) throw new Error(`Migration path must be a regular file: ${entry.name}`);
    const match = MIGRATION_NAME.exec(entry.name);
    if (!match) {
      throw new Error(
        `Invalid migration filename: ${entry.name}; expected NNN_lowercase_snake_case.sql`
      );
    }

    const version = Number(match[1]);
    if (version < 1) throw new Error(`Migration version must start at 001: ${entry.name}`);
    const sql = fs.readFileSync(path.join(migrationsDir, entry.name), 'utf8');
    if (!sql.trim()) throw new Error(`Migration must not be empty: ${entry.name}`);
    assertNoTransactionControl(sql, entry.name);
    return { version, name: entry.name, sql, checksum: migrationChecksum(sql) };
  }).sort((left, right) => left.version - right.version);

  for (let index = 0; index < migrations.length; index += 1) {
    const expected = index + 1;
    if (migrations[index].version !== expected) {
      throw new Error(
        `Migration versions must be consecutive from 001; expected ${String(expected).padStart(3, '0')}, found ${String(migrations[index].version).padStart(3, '0')}`
      );
    }
  }

  return migrations;
}

function migrationTableExists(db) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'"
  ).get());
}

function readMigrationState(db, migrations, { requireCurrent = false } = {}) {
  const metadataExists = migrationTableExists(db);
  const userVersion = db.pragma('user_version', { simple: true });

  if (!metadataExists) {
    if (userVersion !== 0) {
      throw new Error(
        `Migration metadata mismatch: schema_migrations is missing but user_version=${userVersion}`
      );
    }
    if (requireCurrent) throw new Error('Database has not been migrated: schema_migrations is missing');
    return { metadataExists: false, appliedRows: [], currentVersion: 0 };
  }

  let appliedRows;
  try {
    appliedRows = db.prepare(
      'SELECT version, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY version'
    ).all();
  } catch (error) {
    throw new Error(`Invalid schema_migrations metadata: ${error.message}`, { cause: error });
  }

  for (let index = 0; index < appliedRows.length; index += 1) {
    const row = appliedRows[index];
    const expectedVersion = index + 1;
    if (row.version !== expectedVersion) {
      throw new Error(
        `Migration metadata is not contiguous: expected version ${expectedVersion}, found ${row.version}`
      );
    }
    if (!Number.isInteger(row.appliedAt) || row.appliedAt < 0) {
      throw new Error(`Migration ${row.version} has an invalid applied_at value`);
    }

    const migration = migrations[index];
    if (!migration) {
      throw new Error(`Applied migration ${row.version} (${row.name}) is missing from disk`);
    }
    if (row.name !== migration.name) {
      throw new Error(
        `Migration ${row.version} filename mismatch: database=${row.name}, disk=${migration.name}`
      );
    }
    if (row.checksum !== migration.checksum) {
      throw new Error(`Applied migration ${row.version} checksum mismatch: ${row.name}`);
    }
  }

  const latestRecordedVersion = appliedRows.length;
  if (userVersion !== latestRecordedVersion) {
    throw new Error(
      `Migration metadata mismatch: user_version=${userVersion}, schema_migrations=${latestRecordedVersion}`
    );
  }
  if (userVersion > migrations.length) {
    throw new Error(
      `Database version ${userVersion} is newer than available migrations ${migrations.length}`
    );
  }
  if (requireCurrent && userVersion !== migrations.length) {
    throw new Error(
      `Database is not fully migrated: current=${userVersion}, required=${migrations.length}`
    );
  }

  return { metadataExists: true, appliedRows, currentVersion: userVersion };
}

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
}

function migrateDatabase(db, options = {}) {
  const migrations = loadMigrations(options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
  const now = options.now || (() => Date.now());
  const state = readMigrationState(db, migrations);
  const pending = migrations.slice(state.currentVersion);

  if (pending.length === 0) {
    return { applied: [], currentVersion: state.currentVersion };
  }

  const applied = [];
  let activeMigration = null;
  const applyBatch = db.transaction(() => {
    ensureMigrationTable(db);
    const insertMigration = db.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (@version, @name, @checksum, @appliedAt)
    `);

    for (const migration of pending) {
      activeMigration = migration;
      const appliedAt = now();
      if (!Number.isInteger(appliedAt) || appliedAt < 0) {
        throw new Error('Migration clock must return a non-negative integer timestamp');
      }
      db.exec(migration.sql);
      insertMigration.run({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        appliedAt,
      });
      db.pragma(`user_version = ${migration.version}`);
      applied.push(migration.version);
    }
  });

  try {
    applyBatch.immediate();
  } catch (error) {
    const label = activeMigration?.name || 'metadata initialization';
    throw new Error(`Migration batch failed at ${label} and was rolled back: ${error.message}`, {
      cause: error,
    });
  }

  return {
    applied,
    currentVersion: db.pragma('user_version', { simple: true }),
  };
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATION_NAME,
  assertNoTransactionControl,
  loadMigrations,
  readMigrationState,
  migrateDatabase,
  migrationChecksum,
};
