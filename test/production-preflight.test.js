'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const {
  formatPreflightReport,
  runProductionPreflight,
} = require('../services/production-preflight');

const GROUP = '120300000000000099@g.us';
const ERIC = '60111111111@c.us';
const ADMIN = '60222222222@c.us';
const SECRET = 'sk-or-v1-test-secret-never-print-this';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-preflight-'));
  fs.chmodSync(root, 0o700);
  const env = {
    MY_NUMBER: '60333333333',
    GROUP_ID: GROUP,
    PM_AUTHORIZED_GROUP_JID: GROUP,
    PM_ERIC_JID: ERIC,
    PM_ADMIN_JIDS: ADMIN,
    OPENROUTER_API_KEY: SECRET,
    DB_PATH: path.join(root, 'database', 'wsb.sqlite3'),
    PM_ATTACHMENTS_DIR: path.join(root, 'attachments'),
    PM_TEMP_DIR: path.join(root, 'temporary'),
    PM_BACKUP_DIR: path.join(root, 'backups'),
    PM_OCR_CACHE_PATH: path.join(root, 'ocr-cache'),
    PM_OCR_LANG_PATH: path.join(root, 'tessdata'),
    PM_OCR_ENABLED: 'false',
    ...overrides,
  };
  let db = getDatabase({ filename: env.DB_PATH, busyTimeoutMs: 5000 });
  migrateDatabase(db, { now: () => 1 });
  closeDatabase(db);
  db = null;
  t.after(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, env };
}

test('offline production preflight validates a current private deployment and redacts every identity/key', (t) => {
  const context = fixture(t);
  const result = runProductionPreflight({ env: context.env, nodeVersion: 'v22.15.0' });
  assert.equal(result.ready, true);
  assert.ok(result.checks.some((entry) => entry.name === 'database' && entry.status === 'PASS'));
  assert.ok(result.checks.some((entry) => entry.name.startsWith('disk:') && entry.status === 'PASS'));
  assert.ok(result.checks.some((entry) => entry.name === 'backup:offsite' && entry.status === 'WARN'));

  const report = formatPreflightReport(result, { env: context.env });
  assert.match(report, /offline; no WhatsApp\/network/u);
  assert.match(report, /READINESS: READY/u);
  for (const sensitive of [GROUP, ERIC, ADMIN, SECRET, context.env.MY_NUMBER]) {
    assert.equal(report.includes(sensitive), false, `report leaked ${sensitive}`);
  }
  assert.match(report, /…0099@g\.us/u);
});

test('preflight fails safely for missing traineddata, old Node, and non-private storage', (t) => {
  const context = fixture(t, { PM_OCR_ENABLED: 'true', PM_OCR_LANGUAGES: 'eng+chi_sim' });
  fs.mkdirSync(context.env.PM_OCR_LANG_PATH, { mode: 0o700 });
  fs.mkdirSync(context.env.PM_ATTACHMENTS_DIR, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(context.env.PM_ATTACHMENTS_DIR, 0o755);

  const oldNode = runProductionPreflight({ env: context.env, nodeVersion: 'v20.19.0' });
  assert.equal(oldNode.ready, false);
  assert.ok(oldNode.checks.some((entry) => entry.name === 'node' && entry.status === 'FAIL'));
  assert.ok(oldNode.checks.some((entry) => entry.name === 'ocr' && entry.status === 'FAIL'));
  if (process.platform !== 'win32') {
    assert.ok(oldNode.checks.some((entry) => entry.name === 'storage:attachments' && entry.status === 'FAIL'));
  }
  const report = formatPreflightReport(oldNode, { env: context.env });
  assert.equal(report.includes(SECRET), false);
  assert.equal(report.includes(GROUP), false);
});
