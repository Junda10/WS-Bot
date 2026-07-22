'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const configModule = require('../config');
const {
  loadConfig,
  validateConfig,
  normalizeJid,
  normalizeJidList,
  ConfigValidationError,
} = configModule;

const VALID_ENV = {
  PM_AUTHORIZED_GROUP_JID: '120300000000000000@g.us',
  PM_ERIC_JID: '60111111111@c.us',
  PM_ADMIN_JIDS: '60222222222@c.us, 60333333333@lid',
};

test('loads valid PM defaults and normalizes JIDs', () => {
  const config = validateConfig(loadConfig(VALID_ENV));

  assert.equal(config.pm.authorizedGroupJid, '120300000000000000@g.us');
  assert.equal(config.pm.ericJid, '60111111111@c.us');
  assert.deepEqual(config.pm.adminJids, ['60222222222@c.us', '60333333333@lid']);
  assert.equal(config.storage.maxFileBytes, 20 * 1024 * 1024);
  assert.equal(config.storage.maxPdfPages, 100);
  assert.equal(config.storage.maxPdfTextItems, 500_000);
  assert.equal(config.storage.maxExtractedItems, 500_000);
  assert.equal(config.storage.parserMaxOldSpaceMb, 128);
  assert.equal(config.storage.maxImagePixels, 40_000_000);
  assert.equal(config.storage.maxDocxUncompressedBytes, 100 * 1024 * 1024);
  assert.equal(config.storage.maxExtractedChars, 1_000_000);
  assert.equal(config.storage.processingTimeoutMs, 120_000);
  assert.equal(config.retention.messageDays, 30);
  assert.equal(config.reports.timezone, 'Asia/Kuala_Lumpur');
  assert.equal(config.reports.recoveryWindowHours, 24);
  assert.equal(config.backup.retentionCount, 14);
  assert.equal(config.database.path, path.resolve('data/wsb.sqlite3'));
});

test('normalizes bare user IDs, casing, whitespace, aliases, and duplicates', () => {
  assert.equal(normalizeJid(' 60123456789 '), '60123456789@c.us');
  assert.equal(normalizeJid('ABC123@LID'), 'abc123@lid');
  assert.equal(normalizeJid('60123456789@g.us'), '');
  assert.equal(normalizeJid('60123456789@c.us', { kind: 'group' }), '');
  assert.deepEqual(
    normalizeJidList('60123456789, 60123456789@c.us, ABC123@LID'),
    ['60123456789@c.us', 'abc123@lid']
  );
});

test('reports every missing security-critical PM identity', () => {
  assert.throws(
    () => validateConfig(loadConfig({})),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, /PM_AUTHORIZED_GROUP_JID is required/);
      assert.match(error.message, /PM_ERIC_JID is required/);
      assert.match(error.message, /PM_ADMIN_JIDS must contain at least one/);
      return true;
    }
  );
});

test('rejects malformed JIDs, NaN-like numbers, bad ranges, and invalid policies', () => {
  const config = loadConfig({
    ...VALID_ENV,
    PM_AUTHORIZED_GROUP_JID: 'not-a-group',
    PM_ERIC_JID: '120300000000000000@g.us',
    PM_ADMIN_JIDS: 'not a jid',
    PM_MAX_FILE_MB: '20MB',
    PM_MAX_PDF_PAGES: '0',
    PM_MAX_PDF_TEXT_ITEMS: '0',
    PM_MAX_EXTRACTED_ITEMS: 'many',
    PM_PARSER_MAX_OLD_SPACE_MB: '8',
    PM_MAX_IMAGE_PIXELS: 'many',
    PM_MAX_DOCX_UNCOMPRESSED_MB: '0',
    PM_MAX_EXTRACTED_CHARS: '-1',
    PM_FILE_PROCESSING_TIMEOUT_MS: '999999999',
    PM_MESSAGE_RETENTION_DAYS: '0',
    PM_REPORT_RECOVERY_HOURS: 'forever',
    PM_TIMEZONE: 'Malaysia/Invalid',
    PM_VISION_POLICY: 'always-trust-ai',
    PM_OCR_ENABLED: 'yes',
    SCHEDULE_HOUR: '8am',
  });

  assert.throws(
    () => validateConfig(config),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.match(error.message, /PM_AUTHORIZED_GROUP_JID/);
      assert.match(error.message, /PM_ERIC_JID/);
      assert.match(error.message, /PM_ADMIN_JIDS/);
      assert.match(error.message, /PM_MAX_FILE_MB/);
      assert.match(error.message, /PM_MAX_PDF_PAGES/);
      assert.match(error.message, /PM_MAX_PDF_TEXT_ITEMS/);
      assert.match(error.message, /PM_MAX_EXTRACTED_ITEMS/);
      assert.match(error.message, /PM_PARSER_MAX_OLD_SPACE_MB/);
      assert.match(error.message, /PM_MAX_IMAGE_PIXELS/);
      assert.match(error.message, /PM_MAX_DOCX_UNCOMPRESSED_MB/);
      assert.match(error.message, /PM_MAX_EXTRACTED_CHARS/);
      assert.match(error.message, /PM_FILE_PROCESSING_TIMEOUT_MS/);
      assert.match(error.message, /PM_MESSAGE_RETENTION_DAYS/);
      assert.match(error.message, /PM_REPORT_RECOVERY_HOURS/);
      assert.match(error.message, /PM_TIMEZONE/);
      assert.match(error.message, /PM_VISION_POLICY/);
      assert.match(error.message, /PM_OCR_ENABLED/);
      assert.match(error.message, /SCHEDULE_HOUR/);
      return true;
    }
  );
});

test('supports validation without PM identities for database-only tools', () => {
  assert.doesNotThrow(() => validateConfig(loadConfig({}), { requirePm: false }));
});
