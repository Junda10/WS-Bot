const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

function createMessageDeduper({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const seen = new Map();

  return function isDuplicate(messageId) {
    if (!messageId) return false;

    const timestamp = now();
    const previous = seen.get(messageId);
    if (previous !== undefined && timestamp - previous < ttlMs) return true;

    seen.set(messageId, timestamp);

    for (const [id, seenAt] of seen) {
      if (timestamp - seenAt >= ttlMs) seen.delete(id);
    }
    while (seen.size > maxEntries) {
      seen.delete(seen.keys().next().value);
    }

    return false;
  };
}

module.exports = { createMessageDeduper, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
