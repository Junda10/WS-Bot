const fs = require('fs');
const path = require('path');
const config = require('./config');

const SESSION_FILE = path.join(__dirname, 'data', 'sessions.json');
const DATA_DIR = path.dirname(SESSION_FILE);

let sessions = {};
let flushTimer = null;
const FLUSH_DELAY_MS = 200;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    sessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    sessions = {};
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      ensureDataDir();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2), 'utf8');
    } catch (err) {
      console.error('session flush failed:', err.message);
    }
  }, FLUSH_DELAY_MS);
}

function pruneExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [uid, s] of Object.entries(sessions)) {
    if (!s || !s.expiresAt || s.expiresAt <= now) {
      delete sessions[uid];
      removed++;
    }
  }
  if (removed > 0) scheduleFlush();
  return removed;
}

function getSession(userId) {
  const s = sessions[userId];
  if (!s) return null;
  if (s.expiresAt && s.expiresAt <= Date.now()) {
    delete sessions[userId];
    scheduleFlush();
    return null;
  }
  return s;
}

function setSession(userId, data) {
  const ttl = config.clarification?.sessionTtlMs || 30 * 60 * 1000;
  sessions[userId] = {
    ...data,
    expiresAt: Date.now() + ttl,
  };
  scheduleFlush();
  return sessions[userId];
}

function clearSession(userId) {
  if (sessions[userId]) {
    delete sessions[userId];
    scheduleFlush();
  }
}

load();
pruneExpired();

module.exports = { getSession, setSession, clearSession, pruneExpired };
