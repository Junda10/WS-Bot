'use strict';

const path = require('path');

const DATABASE_CLI_USAGE = '[--db <file>] [--migrations <directory>]';
const ALLOWED_OPTIONS = new Set(['--db', '--migrations']);

class CliArgumentError extends Error {
  constructor(message) {
    super(`${message}\nUsage: ${DATABASE_CLI_USAGE}`);
    this.name = 'CliArgumentError';
  }
}

function getDatabaseCliOptions(argv, config) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { help: true };
  }

  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let name = argument;
    let value;

    const equalsIndex = argument.indexOf('=');
    if (equalsIndex !== -1) {
      name = argument.slice(0, equalsIndex);
      value = argument.slice(equalsIndex + 1);
    }

    if (!ALLOWED_OPTIONS.has(name)) {
      throw new CliArgumentError(`Unknown argument: ${argument}`);
    }
    if (values.has(name)) throw new CliArgumentError(`Duplicate argument: ${name}`);

    if (equalsIndex === -1) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliArgumentError(`Missing value for ${name}`);
      }
      index += 1;
    }
    if (!value || !value.trim()) throw new CliArgumentError(`Empty value for ${name}`);
    values.set(name, value);
  }

  const filename = values.get('--db') || config.database.path;
  const migrations = values.get('--migrations');
  return {
    help: false,
    database: {
      filename: path.resolve(filename),
      busyTimeoutMs: config.database.busyTimeoutMs,
    },
    migrationsDir: migrations ? path.resolve(migrations) : undefined,
  };
}

module.exports = { DATABASE_CLI_USAGE, CliArgumentError, getDatabaseCliOptions };
