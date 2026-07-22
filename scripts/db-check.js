#!/usr/bin/env node
'use strict';

require('dotenv').config();

const configModule = require('../config');
const { getDatabase, closeDatabase } = require('../db/connection');
const { checkDatabase } = require('../db/check');
const { DATABASE_CLI_USAGE, getDatabaseCliOptions } = require('../db/cli-options');

let db;
try {
  const config = configModule.validateConfig(configModule.loadConfig(process.env), { requirePm: false });
  const options = getDatabaseCliOptions(process.argv.slice(2), config);
  if (options.help) {
    console.log(`Usage: npm run db:check -- ${DATABASE_CLI_USAGE}`);
  } else {
    db = getDatabase({ ...options.database, fileMustExist: true });
    const result = checkDatabase(db, {
      migrationsDir: options.migrationsDir,
      busyTimeoutMs: options.database.busyTimeoutMs,
    });
    console.log(
      `SQLite check OK: version=${result.currentVersion}, integrity_check=ok, `
      + `foreign_key_check=ok, journal_mode=${result.pragmas.journalMode}, `
      + `foreign_keys=${result.pragmas.foreignKeys}, `
      + `busy_timeout=${result.pragmas.busyTimeoutMs}, synchronous=NORMAL`
    );
  }
} catch (error) {
  console.error(`SQLite check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
