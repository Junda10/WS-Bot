const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'reply-cache.json');
const MAX_ENTRIES = 200;
const TTL_MS = 24 * 60 * 60 * 1000;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[？?！!。，,.~\s]+/g, ' ')
    .replace(/你是谁|who are you|你叫什么/g, '_identity_')
    .replace(/什么时候|几点|when/g, '_when_')
    .replace(/怎么样|如何|怎样|how/g, '_how_')
    .replace(/为什么|why/g, '_why_')
    .replace(/是什么|what is/g, '_whatis_')
    .replace(/可以吗|能不能|can you/g, '_canyou_')
    .replace(/推荐|建议|suggest|recommend/g, '_recommend_')
    .replace(/最新|latest|newest/g, '_latest_')
    .replace(/最好|best|最佳/g, '_best_')
    .trim();
}

function getReply(question) {
  const cache = loadCache();
  const key = normalize(question);
  const now = Date.now();

  if (cache[key] && now - cache[key].time < TTL_MS) {
    cache[key].hits = (cache[key].hits || 0) + 1;
    saveCache(cache);
    return cache[key].reply;
  }

  for (const [k, v] of Object.entries(cache)) {
    if (now - v.time >= TTL_MS) continue;
    if (similarity(key, k) > 0.75) {
      v.hits = (v.hits || 0) + 1;
      saveCache(cache);
      return v.reply;
    }
  }

  return null;
}

function setReply(question, reply) {
  const cache = loadCache();
  const key = normalize(question);

  cache[key] = { reply, time: Date.now(), hits: 0 };

  const entries = Object.entries(cache);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => a[1].time - b[1].time);
    const trimmed = Object.fromEntries(entries.slice(-MAX_ENTRIES));
    saveCache(trimmed);
  } else {
    saveCache(cache);
  }
}

function similarity(a, b) {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return (2 * overlap) / (wordsA.size + wordsB.size);
}

module.exports = { getReply, setReply };
