const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'user-memory.json');
const MAX_FACTS_PER_USER = 30;

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveMemory(data) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getUserProfile(userId) {
  const mem = loadMemory();
  return mem[userId] || { facts: [], topicCount: {}, lastSeen: null };
}

function addFact(userId, fact) {
  const mem = loadMemory();
  if (!mem[userId]) mem[userId] = { facts: [], topicCount: {}, lastSeen: null };
  const profile = mem[userId];

  if (profile.facts.some(f => f.content === fact)) return;

  profile.facts.push({ content: fact, time: new Date().toISOString() });
  if (profile.facts.length > MAX_FACTS_PER_USER) {
    profile.facts = profile.facts.slice(-MAX_FACTS_PER_USER);
  }
  saveMemory(mem);
}

function trackTopic(userId, topic) {
  const mem = loadMemory();
  if (!mem[userId]) mem[userId] = { facts: [], topicCount: {}, lastSeen: null };
  mem[userId].topicCount[topic] = (mem[userId].topicCount[topic] || 0) + 1;
  mem[userId].lastSeen = new Date().toISOString();
  saveMemory(mem);
}

function getTopTopics(userId, n = 3) {
  const profile = getUserProfile(userId);
  return Object.entries(profile.topicCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([topic]) => topic);
}

function getFactsSummary(userId) {
  const profile = getUserProfile(userId);
  if (profile.facts.length === 0) return '';
  return profile.facts.map(f => `- ${f.content}`).join('\n');
}

function clearMemory(userId) {
  const mem = loadMemory();
  delete mem[userId];
  saveMemory(mem);
}

module.exports = { getUserProfile, addFact, trackTopic, getTopTopics, getFactsSummary, clearMemory };
