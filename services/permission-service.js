'use strict';

const config = require('../config');

const ACTIONS = Object.freeze({
  VIEW: 'VIEW',
  VIEW_DELETED: 'VIEW_DELETED',
  DOWNLOAD: 'DOWNLOAD',
  AI: 'AI',
  CREATE_ISSUE: 'CREATE_ISSUE',
  UPDATE_ISSUE: 'UPDATE_ISSUE',
  RESOLVE_ISSUE: 'RESOLVE_ISSUE',
  CONFIRM_REPLY: 'CONFIRM_REPLY',
  ARCHIVE_ISSUE: 'ARCHIVE_ISSUE',
  DELETE_ISSUE: 'DELETE_ISSUE',
  RESTORE_ISSUE: 'RESTORE_ISSUE',
  MOVE_REPLY: 'MOVE_REPLY',
});

const REQUIRED_ROLE = Object.freeze({
  [ACTIONS.VIEW]: 'MEMBER',
  [ACTIONS.VIEW_DELETED]: 'ADMIN',
  [ACTIONS.DOWNLOAD]: 'MEMBER',
  [ACTIONS.AI]: 'MEMBER',
  [ACTIONS.CREATE_ISSUE]: 'MEMBER',
  [ACTIONS.UPDATE_ISSUE]: 'MEMBER',
  [ACTIONS.RESOLVE_ISSUE]: 'MEMBER',
  [ACTIONS.CONFIRM_REPLY]: 'ERIC',
  [ACTIONS.ARCHIVE_ISSUE]: 'ADMIN',
  [ACTIONS.DELETE_ISSUE]: 'ADMIN',
  [ACTIONS.RESTORE_ISSUE]: 'ADMIN',
  [ACTIONS.MOVE_REPLY]: 'ADMIN',
});

class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

class PermissionService {
  constructor(options = {}) {
    if (!options.repositories?.chats || !options.repositories?.permissions) {
      throw new TypeError('PermissionService requires chat and permission repositories');
    }
    this.repositories = options.repositories;
    this.normalizeJid = options.normalizeJid || config.normalizeJid;
    this.authorizedChatJid = this.normalizeJid(options.authorizedChatJid, { kind: 'group' });
    if (!this.authorizedChatJid) {
      throw new TypeError('authorizedChatJid must be a valid group JID');
    }
  }

  // This check is deliberately first. No identity lookup, media download, AI call,
  // or mutation callback may happen until the configured chat boundary passes.
  assertAuthorizedChat(chatJid) {
    const normalized = this.normalizeJid(chatJid, { kind: 'group' });
    if (!normalized || normalized !== this.authorizedChatJid) {
      throw new AuthorizationError('CHAT_NOT_AUTHORIZED', 'PM operation is not allowed in this chat');
    }
    const chat = this.repositories.chats.findByJid(normalized, { includeDeleted: true });
    if (!chat || chat.enabled !== 1 || chat.deleted_at !== null) {
      throw new AuthorizationError('CHAT_DISABLED', 'Authorized PM chat is unavailable or disabled');
    }
    return chat;
  }

  authorize(action, context = {}) {
    const requiredRole = REQUIRED_ROLE[action];
    if (!requiredRole) throw new TypeError(`Unsupported permission action: ${action}`);

    const chat = this.assertAuthorizedChat(context.chatJid);
    const actorJid = this.normalizeJid(context.actorJid, { kind: 'user' });
    if (!actorJid) {
      throw new AuthorizationError('INVALID_ACTOR_JID', 'A valid actor JID is required');
    }
    const permission = this.repositories.permissions.resolve(chat.id, actorJid);
    if (!permission || !permission.effective_roles.includes(requiredRole)) {
      throw new AuthorizationError(
        'ROLE_REQUIRED',
        `${requiredRole} role is required for ${action}`
      );
    }
    const canonicalJid = this.normalizeJid(permission.canonical_jid, { kind: 'user' });
    if (!canonicalJid) {
      throw new AuthorizationError('INVALID_IDENTITY', 'Permission identity has an invalid canonical JID');
    }
    return {
      action,
      chat,
      permission,
      actorJid: canonicalJid,
      presentedJid: actorJid,
      matchedAliasJid: permission.matched_alias_jid,
    };
  }

  runAuthorized(action, context, work) {
    if (typeof work !== 'function') throw new TypeError('Authorized work must be a function');
    const principal = this.authorize(action, context);
    return work(principal);
  }

  beforeDownload(context, download) {
    return this.runAuthorized(ACTIONS.DOWNLOAD, context, download);
  }

  beforeAi(context, invokeAi) {
    return this.runAuthorized(ACTIONS.AI, context, invokeAi);
  }

  beforeMutation(action, context, mutate) {
    if ([ACTIONS.VIEW, ACTIONS.VIEW_DELETED, ACTIONS.DOWNLOAD, ACTIONS.AI].includes(action)) {
      throw new TypeError('beforeMutation requires a mutation action');
    }
    return this.runAuthorized(action, context, mutate);
  }
}

module.exports = {
  ACTIONS,
  AuthorizationError,
  PermissionService,
  REQUIRED_ROLE,
};
