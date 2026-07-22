'use strict';

const ai = require('../ai');
const { CandidateShortlistService } = require('./candidate-shortlist-service');

function failure(code, message) {
  return {
    ok: false,
    value: null,
    model: null,
    attempts: 0,
    error: { code, message, retryable: false },
  };
}

class PmAiService {
  constructor({
    aiClient = ai,
    candidateShortlist = null,
    issueRepository = null,
    maxCandidates = 8,
    now = Date.now,
  } = {}) {
    for (const method of ['extractIssue', 'matchReply', 'summarizeConversation']) {
      if (!aiClient || typeof aiClient[method] !== 'function') {
        throw new TypeError(`aiClient.${method} is required`);
      }
    }
    this.aiClient = aiClient;
    this.candidateShortlist = candidateShortlist || (issueRepository
      ? new CandidateShortlistService({ issueRepository, maxCandidates, now })
      : null);
  }

  // Task 12 integration seam. Permission checks, source resolution, attachment
  // ownership, and all mutations remain outside this read-only AI service.
  async extractIssue(evidence, context) {
    try {
      return await this.aiClient.extractIssue(evidence, context);
    } catch {
      return failure('AI_CLIENT_FAILURE', 'Issue extraction failed safely');
    }
  }

  shortlistReply(replyEvidence, { chatId, maxCandidates } = {}) {
    if (!this.candidateShortlist) return null;
    try {
      return this.candidateShortlist.shortlist(replyEvidence, { chatId, maxCandidates });
    } catch {
      return null;
    }
  }

  async matchReplyCandidates(replyEvidence, candidates) {
    if (!Array.isArray(candidates)) {
      return failure('SHORTLIST_FAILED', 'Open issue candidates could not be shortlisted');
    }
    try {
      return await this.aiClient.matchReply(replyEvidence, candidates);
    } catch {
      return failure('AI_CLIENT_FAILURE', 'Reply matching failed safely');
    }
  }

  // The service sends only a deterministic bounded shortlist to AI; it does
  // not authorize Eric or confirm/save a reply.
  async matchReply(replyEvidence, { chatId, maxCandidates } = {}) {
    if (!this.candidateShortlist) {
      return failure('SHORTLIST_UNAVAILABLE', 'Candidate shortlist service is not configured');
    }
    const candidates = this.shortlistReply(replyEvidence, { chatId, maxCandidates });
    if (!candidates) {
      return failure('SHORTLIST_FAILED', 'Open issue candidates could not be shortlisted');
    }
    return this.matchReplyCandidates(replyEvidence, candidates);
  }

  // Task 15 integration seam. Window calculation, PM report generation, and
  // WhatsApp formatting/sending are deliberately not implemented here.
  async summarizeConversation(chunks, pmContext) {
    try {
      return await this.aiClient.summarizeConversation(chunks, pmContext);
    } catch {
      return failure('AI_CLIENT_FAILURE', 'Conversation summary failed safely');
    }
  }
}

module.exports = { PmAiService };
