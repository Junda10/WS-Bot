'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getDatabase,
  closeDatabase,
  getPragmaStatus,
} = require('../db/connection');
const {
  assertNoTransactionControl,
  loadMigrations,
  migrateDatabase,
  readMigrationState,
} = require('../db/migrate');
const { checkDatabase } = require('../db/check');
const { CliArgumentError, getDatabaseCliOptions } = require('../db/cli-options');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-db-test-'));
  const migrationsDir = path.join(root, 'migrations');
  const filename = path.join(root, 'private-data', 'wsb.sqlite3');
  fs.mkdirSync(migrationsDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, migrationsDir, filename };
}

function writeMigration(directory, version, slug, sql) {
  const name = `${String(version).padStart(3, '0')}_${slug}.sql`;
  fs.writeFileSync(path.join(directory, name), sql);
  return name;
}

function openFixture(t, fixture, options = {}) {
  const db = getDatabase({ filename: fixture.filename, busyTimeoutMs: 2345, ...options });
  t.after(() => closeDatabase(db));
  return db;
}

test('file-backed database applies migrations once and records checksummed metadata', (t) => {
  const fixture = makeFixture(t);
  writeMigration(fixture.migrationsDir, 1, 'create_widget', `
    CREATE TABLE widget (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;
  `);
  writeMigration(fixture.migrationsDir, 2, 'add_widget_index', `
    CREATE INDEX widget_label_idx ON widget(label);
  `);
  const db = openFixture(t, fixture);

  const first = migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1234 });
  const second = migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 9999 });

  assert.deepEqual(first, { applied: [1, 2], currentVersion: 2 });
  assert.deepEqual(second, { applied: [], currentVersion: 2 });
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  const rows = db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map((row) => row.version), [1, 2]);
  assert.deepEqual(rows.map((row) => row.applied_at), [1234, 1234]);
  assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)));
});

test('project migration 003 upgrades routed rows and adds durable ingress state safely', (t) => {
  const fixture = makeFixture(t);
  const projectMigrations = path.join(__dirname, '..', 'db', 'migrations');
  for (const name of ['001_database_baseline.sql', '002_pm_domain_schema.sql']) {
    fs.copyFileSync(path.join(projectMigrations, name), path.join(fixture.migrationsDir, name));
  }
  const db = openFixture(t, fixture);
  migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
  db.exec(`
    INSERT INTO chats (chat_uid, jid, timezone, created_at, updated_at)
    VALUES ('upgrade-chat', '120300000000000000@g.us', 'UTC', 10, 10);
    INSERT INTO messages (
      message_uid, whatsapp_message_id, chat_id, sender_jid, body,
      sent_at, received_at, created_at
    ) VALUES (
      'pre-003-message', 'pre-003-message', 1, '601@c.us', 'already routed',
      20, 21, 21
    );
  `);

  fs.copyFileSync(
    path.join(projectMigrations, '003_durable_message_ingress.sql'),
    path.join(fixture.migrationsDir, '003_durable_message_ingress.sql')
  );
  assert.deepEqual(migrateDatabase(db, {
    migrationsDir: fixture.migrationsDir, now: () => 2,
  }), { applied: [3], currentVersion: 3 });
  const existing = db.prepare(
    "SELECT processing_status, processing_attempt_count, processing_completed_at FROM messages WHERE whatsapp_message_id='pre-003-message'"
  ).get();
  assert.deepEqual(existing, {
    processing_status: 'PROCESSED', processing_attempt_count: 1, processing_completed_at: 21,
  });
  db.prepare(`
    INSERT INTO messages (
      message_uid, whatsapp_message_id, chat_id, sender_jid, body,
      sent_at, received_at, created_at
    ) VALUES ('post-003-message', 'post-003-message', 1, '601@c.us', 'pending', 30, 31, 31)
  `).run();
  assert.equal(db.prepare(
    "SELECT processing_status FROM messages WHERE whatsapp_message_id='post-003-message'"
  ).get().processing_status, 'PENDING');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('project migration 004 preserves existing messages and adds bounded display names', (t) => {
  const fixture = makeFixture(t);
  const projectMigrations = path.join(__dirname, '..', 'db', 'migrations');
  for (const name of [
    '001_database_baseline.sql',
    '002_pm_domain_schema.sql',
    '003_durable_message_ingress.sql',
  ]) {
    fs.copyFileSync(path.join(projectMigrations, name), path.join(fixture.migrationsDir, name));
  }
  const db = openFixture(t, fixture);
  migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
  db.exec(`
    INSERT INTO chats (chat_uid, jid, timezone, created_at, updated_at)
    VALUES ('display-upgrade-chat', '120300000000000000@g.us', 'UTC', 10, 10);
    INSERT INTO messages (
      message_uid, whatsapp_message_id, chat_id, sender_jid, body,
      sent_at, received_at, created_at
    ) VALUES ('pre-004', 'pre-004', 1, '601@c.us', 'existing', 20, 20, 20);
  `);

  fs.copyFileSync(
    path.join(projectMigrations, '004_message_sender_display_name.sql'),
    path.join(fixture.migrationsDir, '004_message_sender_display_name.sql')
  );
  assert.deepEqual(migrateDatabase(db, {
    migrationsDir: fixture.migrationsDir, now: () => 2,
  }), { applied: [4], currentVersion: 4 });
  assert.equal(db.prepare(
    "SELECT sender_display_name FROM messages WHERE whatsapp_message_id='pre-004'"
  ).get().sender_display_name, null);
  db.prepare(`
    INSERT INTO messages (
      message_uid, whatsapp_message_id, chat_id, sender_jid, sender_display_name,
      body, sent_at, received_at, created_at
    ) VALUES ('post-004', 'post-004', 1, '602@c.us', '小明', 'new', 30, 30, 30)
  `).run();
  assert.equal(db.prepare(
    "SELECT sender_display_name FROM messages WHERE whatsapp_message_id='post-004'"
  ).get().sender_display_name, '小明');
  assert.throws(() => db.prepare(
    "UPDATE messages SET sender_display_name='' WHERE whatsapp_message_id='post-004'"
  ).run(), /CHECK constraint failed/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('production PRAGMAs and private POSIX permissions are effective on disk', (t) => {
  const fixture = makeFixture(t);
  const db = openFixture(t, fixture);
  // Force WAL/SHM creation so their inherited private modes are also verified.
  db.exec('CREATE TABLE pragma_probe (id INTEGER PRIMARY KEY); INSERT INTO pragma_probe VALUES (1);');
  const status = getPragmaStatus(db);

  assert.deepEqual(status, {
    foreignKeys: 1,
    journalMode: 'wal',
    busyTimeoutMs: 2345,
    synchronous: 1,
  });

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(fixture.filename)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(fixture.filename).mode & 0o777, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${fixture.filename}${suffix}`;
      assert.ok(fs.existsSync(sidecar), `${suffix} should exist while WAL database is open`);
      assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
    }
  }
});

test('singleton returns the same connection, rejects another path, and reopens after close', (t) => {
  const fixture = makeFixture(t);
  const other = path.join(fixture.root, 'other', 'other.sqlite3');
  const first = getDatabase({ filename: fixture.filename });
  assert.equal(getDatabase({ filename: fixture.filename }), first);
  assert.throws(() => getDatabase({ filename: other }), /singleton is already open/);

  closeDatabase(first);
  const reopened = getDatabase({ filename: other });
  t.after(() => closeDatabase(reopened));
  assert.equal(reopened.open, true);
});

test('a failed initial migration batch rolls back schema, metadata table, and user_version', (t) => {
  const fixture = makeFixture(t);
  writeMigration(fixture.migrationsDir, 1, 'first_table', 'CREATE TABLE first_table (id INTEGER PRIMARY KEY);');
  writeMigration(fixture.migrationsDir, 2, 'broken_table', 'CREATE TABL this_is_invalid (id INTEGER);');
  const db = openFixture(t, fixture);

  assert.throws(
    () => migrateDatabase(db, { migrationsDir: fixture.migrationsDir }),
    /002_broken_table\.sql and was rolled back/
  );
  assert.equal(db.pragma('user_version', { simple: true }), 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('first_table', 'schema_migrations')").get().count, 0);
});

test('all later pending migrations roll back together while prior versions remain intact', (t) => {
  const fixture = makeFixture(t);
  writeMigration(fixture.migrationsDir, 1, 'stable', 'CREATE TABLE stable (id INTEGER PRIMARY KEY);');
  const db = openFixture(t, fixture);
  migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });

  writeMigration(fixture.migrationsDir, 2, 'pending', 'CREATE TABLE pending (id INTEGER PRIMARY KEY);');
  writeMigration(fixture.migrationsDir, 3, 'broken', 'THIS IS NOT SQL;');
  assert.throws(() => migrateDatabase(db, { migrationsDir: fixture.migrationsDir }), /rolled back/);

  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'pending'").get().count, 0);
});

test('transaction-control SQL is rejected without false positives in comments, strings, or triggers', () => {
  for (const statement of [
    'BEGIN;',
    'BEGIN IMMEDIATE;',
    'COMMIT;',
    'END TRANSACTION;',
    'ROLLBACK;',
    'SAVEPOINT one;',
    'RELEASE one;',
  ]) {
    assert.throws(() => assertNoTransactionControl(statement, '001_bad.sql'), /forbidden transaction-control/);
  }

  assert.doesNotThrow(() => assertNoTransactionControl(`
    -- COMMIT; is documentation, not a statement
    CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE audit (value TEXT);
    INSERT INTO source(value) VALUES ('BEGIN; ROLLBACK;');
    CREATE TRIGGER source_audit AFTER INSERT ON source BEGIN
      INSERT INTO audit(value) VALUES (NEW.value);
      UPDATE audit SET value = CASE WHEN value = 'x' THEN 'END;' ELSE value END;
    END;
  `, '001_safe.sql'));
});

test('migration discovery enforces one lowercase NNN_snake_case policy and contiguous versions', (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(path.join(fixture.migrationsDir, '1-invalid.sql'), 'SELECT 1;');
  assert.throws(() => loadMigrations(fixture.migrationsDir), /expected NNN_lowercase_snake_case\.sql/);

  fs.rmSync(fixture.migrationsDir, { recursive: true });
  fs.mkdirSync(fixture.migrationsDir);
  fs.writeFileSync(path.join(fixture.migrationsDir, '001_VALID.SQL'), 'SELECT 1;');
  assert.throws(() => loadMigrations(fixture.migrationsDir), /Invalid migration filename/);

  fs.rmSync(fixture.migrationsDir, { recursive: true });
  fs.mkdirSync(fixture.migrationsDir);
  writeMigration(fixture.migrationsDir, 1, 'valid', 'SELECT 1;');
  writeMigration(fixture.migrationsDir, 3, 'gap', 'SELECT 3;');
  assert.throws(() => loadMigrations(fixture.migrationsDir), /expected 002, found 003/);
});

test('metadata validation rejects gaps, user_version mismatch, and changed checksums', async (t) => {
  await t.test('gap', (t) => {
    const fixture = makeFixture(t);
    for (let version = 1; version <= 3; version += 1) {
      writeMigration(fixture.migrationsDir, version, `version_${version}`, `SELECT ${version};`);
    }
    const db = openFixture(t, fixture);
    migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
    db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    assert.throws(
      () => readMigrationState(db, loadMigrations(fixture.migrationsDir)),
      /metadata is not contiguous/
    );
  });

  await t.test('user_version mismatch', (t) => {
    const fixture = makeFixture(t);
    writeMigration(fixture.migrationsDir, 1, 'version_one', 'SELECT 1;');
    const db = openFixture(t, fixture);
    migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
    db.pragma('user_version = 0');
    assert.throws(
      () => readMigrationState(db, loadMigrations(fixture.migrationsDir)),
      /user_version=0, schema_migrations=1/
    );
  });

  await t.test('checksum mismatch', (t) => {
    const fixture = makeFixture(t);
    writeMigration(fixture.migrationsDir, 1, 'version_one', 'SELECT 1;');
    const db = openFixture(t, fixture);
    migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
    fs.writeFileSync(path.join(fixture.migrationsDir, '001_version_one.sql'), 'SELECT 2;');
    assert.throws(
      () => readMigrationState(db, loadMigrations(fixture.migrationsDir)),
      /checksum mismatch/
    );
  });
});

test('database check requires a fully migrated database and runs foreign_key_check', async (t) => {
  await t.test('unmigrated and pending', (t) => {
    const fixture = makeFixture(t);
    writeMigration(fixture.migrationsDir, 1, 'one', 'SELECT 1;');
    const db = openFixture(t, fixture);
    assert.throws(
      () => checkDatabase(db, { migrationsDir: fixture.migrationsDir, busyTimeoutMs: 2345 }),
      /has not been migrated/
    );

    migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
    writeMigration(fixture.migrationsDir, 2, 'two', 'SELECT 2;');
    assert.throws(
      () => checkDatabase(db, { migrationsDir: fixture.migrationsDir, busyTimeoutMs: 2345 }),
      /not fully migrated/
    );
  });

  await t.test('foreign key violation', (t) => {
    const fixture = makeFixture(t);
    writeMigration(fixture.migrationsDir, 1, 'foreign_keys', `
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parent(id)
      );
    `);
    const db = openFixture(t, fixture);
    migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO child (id, parent_id) VALUES (1, 999)').run();
    db.pragma('foreign_keys = ON');

    assert.throws(
      () => checkDatabase(db, { migrationsDir: fixture.migrationsDir, busyTimeoutMs: 2345 }),
      /foreign_key_check failed: child\(rowid=1\) -> parent/
    );
  });

  await t.test('healthy current database', (t) => {
    const fixture = makeFixture(t);
    writeMigration(fixture.migrationsDir, 1, 'healthy', 'CREATE TABLE healthy (id INTEGER PRIMARY KEY);');
    const db = openFixture(t, fixture);
    migrateDatabase(db, { migrationsDir: fixture.migrationsDir, now: () => 1 });
    const result = checkDatabase(db, { migrationsDir: fixture.migrationsDir, busyTimeoutMs: 2345 });
    assert.equal(result.currentVersion, 1);
    assert.equal(result.integrity.ok, true);
    assert.equal(result.foreignKeys.ok, true);
  });
});

test('fileMustExist refuses a missing database and corrupt files fail to open', (t) => {
  const fixture = makeFixture(t);
  const missing = path.join(fixture.root, 'does-not-exist', 'missing.sqlite3');
  assert.throws(
    () => getDatabase({ filename: missing, fileMustExist: true }),
    /database does not exist/
  );
  assert.equal(fs.existsSync(missing), false);

  fs.mkdirSync(path.dirname(fixture.filename), { recursive: true });
  fs.writeFileSync(fixture.filename, 'this is not a sqlite database', { mode: 0o600 });
  assert.throws(() => getDatabase({ filename: fixture.filename }), /not a database/);
});

test('CLI options accept only unique, valued known flags', () => {
  const config = { database: { path: '/default/wsb.sqlite3', busyTimeoutMs: 5000 } };
  const parsed = getDatabaseCliOptions(
    ['--db=relative.sqlite3', '--migrations', 'custom-migrations'],
    config
  );
  assert.equal(parsed.database.filename, path.resolve('relative.sqlite3'));
  assert.equal(parsed.migrationsDir, path.resolve('custom-migrations'));
  assert.equal(getDatabaseCliOptions(['--help'], config).help, true);

  for (const argv of [
    ['unexpected'],
    ['--unknown=value'],
    ['--db'],
    ['--db='],
    ['--db', 'one.sqlite3', '--db', 'two.sqlite3'],
    ['--help', '--db', 'one.sqlite3'],
  ]) {
    assert.throws(() => getDatabaseCliOptions(argv, config), CliArgumentError);
  }
});
