'use strict';

const ISSUE_STATUS = Object.freeze({
  WAITING_TEVAU: 'WAITING_TEVAU',
  REPLIED: 'REPLIED',
  RESOLVED: 'RESOLVED',
  ARCHIVED: 'ARCHIVED',
});

const FORWARD_TRANSITIONS = Object.freeze({
  [ISSUE_STATUS.WAITING_TEVAU]: ISSUE_STATUS.REPLIED,
  [ISSUE_STATUS.REPLIED]: ISSUE_STATUS.RESOLVED,
  [ISSUE_STATUS.RESOLVED]: ISSUE_STATUS.ARCHIVED,
});

const RESTORE_RULES = Object.freeze({
  SOFT_DELETED: 'Restore visibility and preserve the lifecycle status and timestamps.',
  ARCHIVED: 'Restore an archived, visible issue to RESOLVED and clear archived_at.',
  DELETED_ARCHIVED: 'First restore visibility while remaining ARCHIVED; a second restore reopens it to RESOLVED.',
});

function canTransition(from, to) {
  return FORWARD_TRANSITIONS[from] === to;
}

module.exports = {
  FORWARD_TRANSITIONS,
  ISSUE_STATUS,
  RESTORE_RULES,
  canTransition,
};
