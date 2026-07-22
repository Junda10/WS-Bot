#!/usr/bin/env node
'use strict';

require('dotenv').config();
const path = require('path');
const config = require('../config');
const { restoreCheck } = require('../services/restore-check-service');

const USAGE = 'Usage: npm run db:restore-check -- <bundle-directory> [--migrations <directory>] [--temp-dir <directory>]';

function parse(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (!argv[0] || argv[0].startsWith('--')) throw new Error(`Bundle directory is required\n${USAGE}`);
  const result = { help: false, bundlePath: path.resolve(argv[0]) };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--migrations', '--temp-dir'].includes(key) || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument: ${key || ''}\n${USAGE}`);
    }
    const property = key === '--migrations' ? 'migrationsDir' : 'tempDir';
    if (result[property]) throw new Error(`Duplicate argument: ${key}\n${USAGE}`);
    result[property] = path.resolve(value);
  }
  return result;
}

(async () => {
  try {
    const options = parse(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      return;
    }
    config.assertValid({ requirePm: false });
    const result = await restoreCheck(options.bundlePath, {
      migrationsDir: options.migrationsDir,
      tempDir: options.tempDir,
      busyTimeoutMs: config.database.busyTimeoutMs,
    });
    console.log(`Restore check OK: schema=${result.schemaVersion}, files=${result.fileCount}, issueAttachments=${result.attachmentCount}`);
  } catch (error) {
    console.error(`Restore check FAILED: ${error.message}`);
    process.exitCode = 1;
  }
})();
