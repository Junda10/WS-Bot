'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const configModule = require('../config');
const { checkDatabase } = require('../db/check');
const { closeDatabase, getDatabase } = require('../db/connection');

const MIN_NODE_MAJOR = 22;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MIB = 1024 * 1024;

function formatBytes(value) {
  const bytes = typeof value === 'bigint' ? value : BigInt(Math.max(0, Number(value) || 0));
  if (bytes >= 1024n ** 3n) return `${(Number(bytes) / (1024 ** 3)).toFixed(2)} GiB`;
  if (bytes >= 1024n ** 2n) return `${(Number(bytes) / (1024 ** 2)).toFixed(2)} MiB`;
  if (bytes >= 1024n) return `${(Number(bytes) / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

function maskJid(value) {
  const jid = String(value || '');
  const at = jid.lastIndexOf('@');
  if (at < 1) return '(未配置)';
  const local = jid.slice(0, at);
  const domain = jid.slice(at + 1);
  return `…${local.slice(-4)}@${domain}`;
}

function redact(value, env = {}) {
  let text = String(value ?? '');
  const exactSecrets = [env.OPENROUTER_API_KEY, env.MY_NUMBER]
    .filter((entry) => typeof entry === 'string' && entry.length > 0);
  for (const secret of exactSecrets) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/[a-z0-9._:-]+@(g\.us|c\.us|lid)/giu, (jid) => maskJid(jid));
  text = text.replace(/sk-[a-z0-9_-]{8,}/giu, 'sk-[REDACTED]');
  return text;
}

function check(name, status, message, details = {}) {
  return Object.freeze({ name, status, message, ...details });
}

function assertPrivateDirectory(directory, label, { create = true } = {}) {
  const resolved = path.resolve(directory);
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a file or symlink`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current process user`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group/other access (expected 0700)`);
  }
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  const probe = path.join(resolved, `.wsb-preflight-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(probe, 'wx', PRIVATE_FILE_MODE);
    fs.writeSync(descriptor, 'private preflight probe');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(probe, { force: true });
  }
  return fs.realpathSync(resolved);
}

function assertPrivateFile(filename, label) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current process user`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group/other access (expected 0600)`);
  }
  fs.accessSync(filename, fs.constants.R_OK | fs.constants.W_OK);
  return stat;
}

function directoryBytes(directory) {
  let total = 0n;
  const pending = [path.resolve(directory)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`storage contains a symlink: ${filename}`);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile()) total += fs.statSync(filename, { bigint: true }).size;
    }
  }
  return total;
}

function filesystemFreeBytes(directory) {
  const stats = fs.statfsSync(directory, { bigint: true });
  return stats.bavail * stats.bsize;
}

function nodeMajor(version) {
  const match = /^v?(\d+)(?:\.|$)/u.exec(String(version || ''));
  return match ? Number(match[1]) : Number.NaN;
}

function configuredRuntimeIdentities(config, env) {
  const errors = [];
  const myNumber = String(env.MY_NUMBER || '').trim();
  if (!/^\d{8,20}$/u.test(myNumber)) errors.push('MY_NUMBER must contain 8-20 digits');
  const group = configModule.normalizeJid(env.GROUP_ID, { kind: 'group' });
  if (!group) errors.push('GROUP_ID is required and must end in @g.us');
  return { errors, myNumber, group };
}

function traineddataCandidates(directory, language) {
  return [
    path.join(directory, `${language}.traineddata`),
    path.join(directory, `${language}.traineddata.gz`),
  ];
}

function runProductionPreflight(options = {}) {
  const env = options.env || process.env;
  const version = options.nodeVersion || process.version;
  const checks = [];
  let config;

  const major = nodeMajor(version);
  checks.push(major >= MIN_NODE_MAJOR
    ? check('node', 'PASS', `Node ${major} meets the Node ${MIN_NODE_MAJOR}+ baseline`)
    : check('node', 'FAIL', `Node ${String(version)} is unsupported; Node ${MIN_NODE_MAJOR}+ is required`));

  try {
    config = configModule.validateConfig(configModule.loadConfig(env), { requirePm: true });
    checks.push(check('config', 'PASS', 'Central configuration validation passed'));
  } catch (error) {
    checks.push(check('config', 'FAIL', redact(error.message, env)));
    return Object.freeze({ ready: false, checks: Object.freeze(checks), config: null });
  }

  const runtime = configuredRuntimeIdentities(config, env);
  checks.push(runtime.errors.length === 0
    ? check('runtime-identities', 'PASS', `Runtime identities present: MY_NUMBER=[REDACTED], GROUP_ID=${maskJid(runtime.group)}`)
    : check('runtime-identities', 'FAIL', runtime.errors.join('; ')));
  checks.push(check(
    'pm-identities',
    'PASS',
    `PM identities valid: group=${maskJid(config.pm.authorizedGroupJid)}, Eric=${maskJid(config.pm.ericJid)}, admins=${config.pm.adminJids.length}`
  ));

  const apiKey = String(env.OPENROUTER_API_KEY || '').trim();
  const plausibleKey = apiKey.length >= 16 && !/x{6,}|replace|example/iu.test(apiKey);
  checks.push(plausibleKey
    ? check('openrouter', 'PASS', 'OpenRouter key is configured (redacted; no request made)')
    : check('openrouter', 'WARN', 'OpenRouter key is absent or looks like a placeholder; deterministic PM/summary fallback remains available'));

  const directories = [
    ['database-parent', path.dirname(config.database.path)],
    ['attachments', config.storage.attachmentsDir],
    ['temporary', config.storage.tempDir],
    ['backup', config.backup.directory],
  ];
  if (config.media.ocrEnabled) directories.push(['ocr-cache', config.media.ocrCachePath]);
  const canonicalDirectories = new Map();
  for (const [name, directory] of directories) {
    try {
      canonicalDirectories.set(name, assertPrivateDirectory(directory, name));
      checks.push(check(`storage:${name}`, 'PASS', `${name} is private and writable`, { path: directory }));
    } catch (error) {
      checks.push(check(`storage:${name}`, 'FAIL', redact(error.message, env), { path: directory }));
    }
  }

  if (!fs.existsSync(config.database.path)) {
    checks.push(check('database', 'FAIL', 'Database does not exist; run npm run db:migrate before preflight'));
  } else {
    let db;
    try {
      assertPrivateFile(config.database.path, 'SQLite database');
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${config.database.path}${suffix}`;
        if (fs.existsSync(sidecar)) assertPrivateFile(sidecar, `SQLite ${suffix.slice(1)} sidecar`);
      }
      db = getDatabase({
        filename: config.database.path,
        busyTimeoutMs: config.database.busyTimeoutMs,
        fileMustExist: true,
      });
      const result = checkDatabase(db, { busyTimeoutMs: config.database.busyTimeoutMs });
      checks.push(check('database', 'PASS', `SQLite integrity, foreign keys, PRAGMAs, and current migrations passed (schema ${result.currentVersion})`));
    } catch (error) {
      checks.push(check('database', 'FAIL', redact(error.message, env)));
    } finally {
      closeDatabase(db);
    }
  }

  if (config.media.ocrEnabled) {
    try {
      const root = path.resolve(config.media.ocrLangPath);
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('OCR language path must be a real directory');
      const missing = [];
      for (const language of config.media.ocrLanguages.split('+')) {
        const candidate = traineddataCandidates(root, language).find((filename) => fs.existsSync(filename));
        if (!candidate) { missing.push(language); continue; }
        const dataStat = fs.lstatSync(candidate);
        if (!dataStat.isFile() || dataStat.isSymbolicLink() || dataStat.size === 0) missing.push(language);
        else fs.accessSync(candidate, fs.constants.R_OK);
      }
      if (missing.length) throw new Error(`Missing/read-invalid local traineddata: ${missing.join(', ')}`);
      checks.push(check('ocr', 'PASS', `Local OCR traineddata available for ${config.media.ocrLanguages}`));
    } catch (error) {
      checks.push(check('ocr', 'FAIL', redact(error.message, env)));
    }
  } else {
    checks.push(check('ocr', 'PASS', 'OCR is disabled; no traineddata is required'));
  }

  if (config.backup.offsiteDirectory) {
    try {
      const canonical = assertPrivateDirectory(config.backup.offsiteDirectory, 'offsite backup');
      canonicalDirectories.set('offsite', canonical);
      checks.push(check('backup:offsite', 'PASS', 'Optional filesystem offsite destination is private and writable', {
        path: config.backup.offsiteDirectory,
      }));
    } catch (error) {
      checks.push(check('backup:offsite', 'FAIL', redact(error.message, env), {
        path: config.backup.offsiteDirectory,
      }));
    }
  } else {
    checks.push(check('backup:offsite', 'WARN', 'PM_BACKUP_OFFSITE_DIR is not configured; verified local backups remain enabled'));
  }

  try {
    const archiveBytes = canonicalDirectories.has('attachments')
      ? directoryBytes(canonicalDirectories.get('attachments')) : 0n;
    const databaseBytes = fs.existsSync(config.database.path)
      ? fs.statSync(config.database.path, { bigint: true }).size : 0n;
    const requirements = [
      ['attachments', BigInt(config.storage.maxFileBytes) * 2n],
      ['temporary', BigInt(config.storage.maxFileBytes)
        + BigInt(config.storage.maxDocxUncompressedBytes)
        + (config.media.ocrEnabled ? BigInt(config.media.maxOcrImageBytes) : 0n)],
      ['backup', databaseBytes + archiveBytes + BigInt(config.storage.maxFileBytes) + BigInt(16 * MIB)],
    ];
    if (canonicalDirectories.has('offsite')) {
      requirements.push(['offsite', databaseBytes + archiveBytes + BigInt(config.storage.maxFileBytes)]);
    }
    const byFilesystem = new Map();
    for (const [name, required] of requirements) {
      const directory = canonicalDirectories.get(name);
      if (!directory) continue;
      const device = String(fs.statSync(directory, { bigint: true }).dev);
      const existing = byFilesystem.get(device) || { directory, names: [], required: 0n };
      existing.names.push(name);
      existing.required += required;
      byFilesystem.set(device, existing);
    }
    for (const entry of byFilesystem.values()) {
      const free = filesystemFreeBytes(entry.directory);
      const status = free >= entry.required ? 'PASS' : 'FAIL';
      checks.push(check(
        `disk:${entry.names.join('+')}`,
        status,
        `Disk free ${formatBytes(free)}; required reserve ${formatBytes(entry.required)} from configured file/parser/backup limits`,
        { path: entry.directory, freeBytes: free, requiredBytes: entry.required }
      ));
    }
  } catch (error) {
    checks.push(check('disk', 'FAIL', redact(error.message, env)));
  }

  const ready = !checks.some((entry) => entry.status === 'FAIL');
  return Object.freeze({ ready, checks: Object.freeze(checks), config });
}

function formatPreflightReport(result, options = {}) {
  const env = options.env || process.env;
  const lines = ['WSB production preflight (offline; no WhatsApp/network)', ''];
  for (const entry of result.checks) {
    lines.push(`[${entry.status}] ${entry.name}: ${redact(entry.message, env)}`);
  }
  lines.push('', `READINESS: ${result.ready ? 'READY' : 'NOT READY'}`);
  return lines.join('\n');
}

module.exports = {
  MIN_NODE_MAJOR,
  assertPrivateDirectory,
  directoryBytes,
  formatBytes,
  formatPreflightReport,
  maskJid,
  redact,
  runProductionPreflight,
};
