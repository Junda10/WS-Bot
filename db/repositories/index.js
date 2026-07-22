'use strict';

const { AttachmentRepository } = require('./attachment-repository');
const { ChatRepository } = require('./chat-repository');
const { IssueRepository } = require('./issue-repository');
const { MessageRepository } = require('./message-repository');
const { PermissionRepository } = require('./permission-repository');
const { ReplyMatchRepository } = require('./reply-match-repository');
const { SummaryRepository } = require('./summary-repository');
const { immediate, requireDatabase } = require('./shared');

function createRepositories(db) {
  requireDatabase(db);
  const repositories = {
    chats: new ChatRepository(db),
    permissions: new PermissionRepository(db),
    messages: new MessageRepository(db),
    issues: new IssueRepository(db),
    attachments: new AttachmentRepository(db),
    replyMatches: new ReplyMatchRepository(db),
    summaries: new SummaryRepository(db),
  };
  repositories.transaction = (work) => {
    if (typeof work !== 'function') throw new TypeError('transaction work must be a function');
    return immediate(db, () => work(repositories));
  };
  return repositories;
}

module.exports = {
  AttachmentRepository,
  ChatRepository,
  IssueRepository,
  MessageRepository,
  PermissionRepository,
  ReplyMatchRepository,
  SummaryRepository,
  createRepositories,
};
