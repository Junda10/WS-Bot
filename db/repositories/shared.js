'use strict';

const crypto = require('crypto');

function requireDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A better-sqlite3 database connection is required');
  }
  return db;
}

function requireInteger(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be a safe integer >= ${min}`);
  }
  return value;
}

function requireTimestamp(value, name = 'timestamp') {
  return requireInteger(value, name, { min: 0 });
}

function requireString(value, name, { max = Infinity, min = 1 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new TypeError(`${name} must be a string with length ${min}..${max}`);
  }
  return value;
}

function optionalString(value, name, options) {
  if (value === null || value === undefined) return null;
  return requireString(value, name, options);
}

function uid(value, name) {
  return value === undefined ? crypto.randomUUID() : requireString(value, name, { max: 200 });
}

function booleanInteger(value, defaultValue = false) {
  if (value === undefined) return defaultValue ? 1 : 0;
  if (value !== true && value !== false && value !== 0 && value !== 1) {
    throw new TypeError('boolean value must be true, false, 0, or 1');
  }
  return value ? 1 : 0;
}

function jsonValue(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
    } catch {
      throw new TypeError(`${name} must contain valid JSON`);
    }
    return value;
  }
  return JSON.stringify(value);
}

function immediate(db, work) {
  // better-sqlite3 implements nested transactions with SAVEPOINTs. Always wrap
  // multi-statement repository operations so a caller may catch an operation
  // failure without accidentally committing its partial sequence/state writes.
  return db.transaction(work).immediate();
}

function assertIdempotent(existing, expected, fields, label) {
  for (const field of fields) {
    if (existing[field] !== expected[field]) {
      throw new Error(`${label} idempotency conflict on ${field}`);
    }
  }
}

function normalizeSearchQuery(text) {
  requireString(text, 'query', { max: 1000 });
  const trimmed = text.trim();
  if (!trimmed) throw new TypeError('query must contain a searchable term');
  const terms = trimmed.split(/\s+/u).filter(Boolean);
  return {
    text: trimmed,
    fts: terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND '),
    // FTS5 trigram does not index terms shorter than three Unicode code points.
    useFts: terms.every((term) => Array.from(term).length >= 3),
    like: `%${trimmed.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
  };
}

module.exports = {
  assertIdempotent,
  booleanInteger,
  immediate,
  jsonValue,
  normalizeSearchQuery,
  optionalString,
  requireDatabase,
  requireInteger,
  requireString,
  requireTimestamp,
  uid,
};
