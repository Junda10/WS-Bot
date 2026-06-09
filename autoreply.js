// Per-number auto-reply allow/block list with admin approval.
// Stores each contact's status: 'on' | 'off' | 'pending'.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'autoreply-list.json');

function _load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function _save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Reduce any WhatsApp id / typed number to a bare digit string (the list key).
function normalize(numberOrId) {
  return String(numberOrId || '').replace(/@c\.us$/i, '').replace(/\D/g, '');
}

function getStatus(numberOrId) {
  const entry = _load()[normalize(numberOrId)];
  return entry ? entry.status : null; // null = never seen (new)
}

function getEntry(numberOrId) {
  return _load()[normalize(numberOrId)] || null;
}

// Record a brand-new contact as pending. No-op if already known. Returns true if newly added.
function markPending(numberOrId, name) {
  const data = _load();
  const key = normalize(numberOrId);
  if (!key || data[key]) return false;
  const now = new Date().toISOString();
  data[key] = { status: 'pending', name: name || '', firstSeen: now, updatedAt: now };
  _save(data);
  return true;
}

function setStatus(numberOrId, status, name) {
  const data = _load();
  const key = normalize(numberOrId);
  if (!key) return null;
  const now = new Date().toISOString();
  const prev = data[key] || {};
  data[key] = {
    status,
    name: name || prev.name || '',
    firstSeen: prev.firstSeen || now,
    updatedAt: now,
  };
  _save(data);
  return data[key];
}

function listAll() {
  return _load();
}

module.exports = { normalize, getStatus, getEntry, markPending, setStatus, listAll };
