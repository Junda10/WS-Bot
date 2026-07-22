const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

function createMessageDeduper({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const seen = new Map();

  function prune(timestamp) {
    for (const [id, seenAt] of seen) {
      if (timestamp - seenAt >= ttlMs) seen.delete(id);
    }
    while (seen.size > maxEntries) {
      seen.delete(seen.keys().next().value);
    }
  }

  function isDuplicate(messageId) {
    if (!messageId) return false;

    const timestamp = now();
    const previous = seen.get(messageId);
    if (previous !== undefined && timestamp - previous < ttlMs) return true;

    seen.set(messageId, timestamp);
    prune(timestamp);
    return false;
  }

  // Durable ingress records an ID only after the database state reaches
  // PROCESSED. Legacy routes can forget a reservation after failure. Keeping
  // these operations on the callable preserves the original API.
  isDuplicate.remember = (messageId) => {
    if (!messageId) return;
    const timestamp = now();
    seen.set(messageId, timestamp);
    prune(timestamp);
  };
  isDuplicate.forget = (messageId) => seen.delete(messageId);
  isDuplicate.has = (messageId) => {
    if (!messageId) return false;
    const timestamp = now();
    prune(timestamp);
    const seenAt = seen.get(messageId);
    return seenAt !== undefined && timestamp - seenAt < ttlMs;
  };

  return isDuplicate;
}

module.exports = { createMessageDeduper, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
