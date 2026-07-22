'use strict';

const OPEN_STATUSES = new Set(['WAITING_TEVAU', 'REPLIED']);
const MAX_AI_CANDIDATES = 12;
const MAX_EVIDENCE_CHARS = 12000;
const MAX_SEARCH_TERMS = 16;

function requirePositiveInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function evidenceText(value, state = { length: 0 }, depth = 0) {
  if (depth > 6) throw new TypeError('reply evidence is nested too deeply');
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new TypeError('reply evidence contains NUL');
    state.length += value.length;
    if (state.length > MAX_EVIDENCE_CHARS) throw new RangeError('reply evidence is too large');
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length > 50) throw new TypeError('reply evidence has too many items');
    return value.map((item) => evidenceText(item, state, depth + 1)).join('\n');
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 30) throw new TypeError('reply evidence has too many fields');
    return entries.map(([key, item]) => `${key}: ${evidenceText(item, state, depth + 1)}`).join('\n');
  }
  throw new TypeError('reply evidence must be JSON-safe');
}

function extractSearchTerms(text) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US');
  const terms = [];
  const seen = new Set();
  const add = (term) => {
    const clean = term.trim();
    if (Array.from(clean).length < 3 || clean.length > 100 || seen.has(clean)) return;
    seen.add(clean);
    terms.push(clean);
  };

  const sequences = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) || [];
  for (const sequence of sequences) {
    const chars = Array.from(sequence);
    if (/^\p{Script=Han}+$/u.test(sequence)) {
      if (chars.length <= 8) add(sequence);
      // Trigram FTS can use bounded CJK windows even when a whole sentence has
      // no spaces. Keep order deterministic and cap below repository limits.
      for (let index = 0; index + 3 <= chars.length && terms.length < MAX_SEARCH_TERMS; index += 2) {
        add(chars.slice(index, index + Math.min(6, chars.length - index)).join(''));
      }
    } else {
      add(sequence);
    }
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms.slice(0, MAX_SEARCH_TERMS);
}

function compactText(value, max) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

function overlapScore(row, terms) {
  const title = String(row.title || '').normalize('NFKC').toLocaleLowerCase('en-US');
  const description = String(row.description || '').normalize('NFKC').toLocaleLowerCase('en-US');
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 12;
    if (description.includes(term)) score += 5;
  }
  return score;
}

class CandidateShortlistService {
  constructor({ issueRepository, maxCandidates = 8, searchLimit = 40, now = Date.now } = {}) {
    if (!issueRepository
        || typeof issueRepository.searchOpenCandidates !== 'function'
        || typeof issueRepository.listRecentOpenCandidates !== 'function') {
      throw new TypeError('issueRepository with bounded candidate queries is required');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.issueRepository = issueRepository;
    this.maxCandidates = requirePositiveInteger(maxCandidates, 'maxCandidates', MAX_AI_CANDIDATES);
    this.searchLimit = requirePositiveInteger(searchLimit, 'searchLimit', 100);
    this.now = now;
  }

  shortlist(replyEvidence, { chatId, maxCandidates = this.maxCandidates } = {}) {
    const limit = requirePositiveInteger(maxCandidates, 'maxCandidates', MAX_AI_CANDIDATES);
    if (!Number.isSafeInteger(chatId) || chatId < 1) throw new TypeError('chatId must be a positive integer');
    const text = evidenceText(replyEvidence).trim();
    if (!text) throw new TypeError('reply evidence must not be empty');
    const terms = extractSearchTerms(text);
    const lexical = terms.length
      ? this.issueRepository.searchOpenCandidates(terms, {
        chatId, limit: this.searchLimit,
      })
      : [];
    const recent = this.issueRepository.listRecentOpenCandidates(chatId, {
      limit: this.searchLimit,
    });

    const lexicalPosition = new Map(lexical.map((row, index) => [row.id, index]));
    const rows = new Map();
    for (const row of [...lexical, ...recent]) {
      if (row && OPEN_STATUSES.has(row.status) && row.deleted_at === null) rows.set(row.id, row);
    }

    const referenceTime = this.now();
    if (!Number.isSafeInteger(referenceTime) || referenceTime < 0) {
      throw new TypeError('now() must return a non-negative millisecond timestamp');
    }
    const ranked = [...rows.values()].map((row) => {
      const ftsPosition = lexicalPosition.get(row.id);
      const updatedAt = Number.isSafeInteger(row.updated_at) ? row.updated_at : row.created_at;
      const ageDays = Math.max(0, referenceTime - updatedAt) / 86400000;
      const recency = 12 / (1 + ageDays / 30);
      const fts = ftsPosition === undefined ? 0 : Math.max(10, 40 - ftsPosition);
      const state = row.status === 'WAITING_TEVAU' ? 6 : 2;
      return {
        row,
        score: overlapScore(row, terms) + recency + fts + state,
        ftsPosition: ftsPosition ?? Number.MAX_SAFE_INTEGER,
      };
    });

    ranked.sort((left, right) => right.score - left.score
      || left.ftsPosition - right.ftsPosition
      || right.row.updated_at - left.row.updated_at
      || left.row.id - right.row.id);

    return ranked.slice(0, limit).map(({ row }) => ({
      publicId: row.public_id,
      title: compactText(row.title, 200),
      description: compactText(row.description, 1000),
      status: row.status,
      createdAt: row.created_at,
    }));
  }
}

module.exports = {
  CandidateShortlistService,
  MAX_AI_CANDIDATES,
  extractSearchTerms,
};
