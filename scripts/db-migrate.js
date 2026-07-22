#!/usr/bin/env node
'use strict';

require('dotenv').config();

const configModule = require('../config');
const { getDatabase, closeDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { DATABASE_CLI_USAGE, getDatabaseCliOptions } = require('../db/cli-options');

let db;
try {
  const config = configModule.validateConfig(configModule.loadConfig(process.env), { requirePm: false });
  const options = getDatabaseCliOptions(process.argv.slice(2), config);
  if (options.help) {
    console.log(`Usage: npm run db:migrate -- ${DATABASE_CLI_USAGE}`);
  } else {
    db = getDatabase(options.database);
    const result = migrateDatabase(db, { migrationsDir: options.migrationsDir });
    const applied = result.applied.length ? result.applied.join(', ') : 'none';
    console.log(`SQLite migrations OK: version=${result.currentVersion}, applied=${applied}`);
  }
} catch (error) {
  console.error(`SQLite migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
