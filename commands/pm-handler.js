'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AuthorizationError } = require('../services/permission-service');
const { IssueDomainError } = require('../services/issue-service');
const {
  formatIssueDetail,
  formatMutationSuccess,
  formatOpenList,
  formatPmHelp,
  formatSearchResults,
  safeDisplayLine,
  splitWhatsAppText,
} = require('./pm-formatters');

const PUBLIC_ID_PATTERN = /^TV[1-9]\d{0,14}$/u;
const OPTION_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const MAX_OPTION_VALUE_LENGTH = 1000;
const MAX_SEARCH_LENGTH = 1000;

class CommandInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandInputError';
    this.code = code;
  }
}

function publicId(value, name = '工单编号') {
  const normalized = String(value || '').trim().toUpperCase();
  if (!PUBLIC_ID_PATTERN.test(normalized)) {
    throw new CommandInputError('INVALID_PUBLIC_ID', `${name}必须是 TVn，例如 TV6`);
  }
  return normalized;
}

function positiveInteger(value, name) {
  if (!/^\d+$/u.test(String(value || ''))) {
    throw new CommandInputError('INVALID_INTEGER', `${name}必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CommandInputError('INVALID_INTEGER', `${name}必须是安全的正整数`);
  }
  return parsed;
}

function parseKeyValues(tokens, options = {}) {
  if (!Array.isArray(tokens)) throw new TypeError('tokens must be an array');
  const allowed = new Set(options.allowed || []);
  const values = Object.create(null);
  for (const token of tokens) {
    const separator = String(token).indexOf('=');
    if (separator < 1) {
      throw new CommandInputError('EXPECTED_KEY_VALUE', `参数“${String(token).slice(0, 30)}”必须使用 key=value`);
    }
    const key = String(token).slice(0, separator).toLowerCase();
    const value = String(token).slice(separator + 1);
    if (!OPTION_KEY_PATTERN.test(key) || !allowed.has(key)) {
      throw new CommandInputError('UNKNOWN_OPTION', `不支持参数 ${key || '(空键)'}`);
    }
    if (Object.hasOwn(values, key)) {
      throw new CommandInputError('DUPLICATE_OPTION', `参数 ${key} 不能重复`);
    }
    if (value.length > (options.maxValueLength ?? MAX_OPTION_VALUE_LENGTH)) {
      throw new CommandInputError('OPTION_TOO_LONG', `参数 ${key} 过长`);
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
      throw new CommandInputError('UNSAFE_OPTION', `参数 ${key} 含有不允许的控制字符`);
    }
    values[key] = value;
  }
  return values;
}

function booleanOption(value, name) {
  if (value === undefined) return false;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new CommandInputError('INVALID_BOOLEAN', `${name} 必须是 true 或 false`);
}

function quoteSource(context) {
  const quote = context.normalized?.quoted;
  if (quote?.chatJid && quote.chatJid !== context.normalized?.chatJid) return null;
  return context.persisted?.quoted_whatsapp_message_id || quote?.id || null;
}

function actorContext(context) {
  const chatJid = context.normalized?.chatJid;
  const actorJid = context.normalized?.senderJid;
  if (!chatJid || !actorJid) {
    throw new CommandInputError(
      'MISSING_RUNTIME_IDENTITY',
      '命令缺少实际群聊或发送者 JID，无法安全执行'
    );
  }
  return { chatJid, actorJid };
}

function stableUid(context, operation, suffix = '') {
  const source = String(context.normalized?.id || context.persisted?.whatsapp_message_id || '');
  if (!source) {
    throw new CommandInputError('MISSING_MESSAGE_ID', '命令缺少 WhatsApp message ID');
  }
  const digest = crypto.createHash('sha256').update(`${source}\0${operation}\0${suffix}`).digest('hex');
  return `pm:${operation}:${digest.slice(0, 40)}`;
}

function archivedFileUnavailable(message) {
  return new IssueDomainError('ATTACHMENT_UNAVAILABLE', message);
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/** Resolve an opaque storage key without ever trusting it as a filesystem path. */
function resolveArchivedAttachmentPath(storageKey, attachmentsDir) {
  if (typeof attachmentsDir !== 'string' || !path.isAbsolute(attachmentsDir)) {
    throw new TypeError('attachmentsDir must be an explicit absolute path');
  }
  if (typeof storageKey !== 'string' || !storageKey || storageKey.includes('\0')) {
    throw archivedFileUnavailable('Attachment storage key is unavailable');
  }
  if (path.isAbsolute(storageKey)) {
    throw archivedFileUnavailable('Absolute attachment storage keys are not allowed');
  }

  const configuredRoot = path.resolve(attachmentsDir);
  const candidate = path.resolve(configuredRoot, storageKey);
  if (!isStrictDescendant(configuredRoot, candidate)) {
    throw archivedFileUnavailable('Attachment storage key escapes the configured archive');
  }

  try {
    // Check both lexical containment and canonical containment. The latter
    // prevents a symlink in any path component from escaping the archive.
    const realRoot = fs.realpathSync(configuredRoot);
    const realCandidate = fs.realpathSync(candidate);
    if (!isStrictDescendant(realRoot, realCandidate)) {
      throw archivedFileUnavailable('Attachment symlink escapes the configured archive');
    }
    if (!fs.statSync(realCandidate).isFile()) {
      throw archivedFileUnavailable('Archived attachment is not a regular file');
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof IssueDomainError) throw error;
    throw archivedFileUnavailable('Archived attachment file is missing or inaccessible');
  }
}

function knownErrorMessage(error) {
  if (error instanceof CommandInputError) return `⚠️ 命令参数错误：${error.message}`;
  if (error instanceof AuthorizationError) {
    if (error.code === 'ROLE_REQUIRED') return `⛔ 无权限：${error.message}`;
    return `⛔ 此处不能执行 PM 命令：${error.message}`;
  }
  if (error instanceof IssueDomainError) {
    const messages = {
      ISSUE_NOT_FOUND: '找不到工单（可能已删除、编号错误或不属于本群）',
      ATTACHMENT_NOT_FOUND: '找不到该工单附件',
      ATTACHMENT_UNAVAILABLE: '附件记录存在，但归档文件缺失或路径不安全',
      REPLY_NOT_FOUND: '找不到该已确认回复',
      REPLY_SELECTION_REQUIRED: error.message,
      OWNER_NOT_MEMBER: '负责人必须是本群已启用的成员',
      ILLEGAL_TRANSITION: `当前状态不允许此操作：${error.message}`,
      ILLEGAL_MOVE: '无法移动回复：来源、目标或回复时间不符合工单规则',
      REPLY_SESSION_NOT_FOUND: '找不到本群的回复确认会话',
      REPLY_CONFIRMATION_REJECTED: '回复确认已失效、已使用或与当前工单不匹配',
      NOT_RESTORABLE: '该工单当前不可恢复',
      AMBIGUOUS_SOURCE: error.message,
    };
    return `❌ 操作未完成：${messages[error.code] || error.message}`;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return `⚠️ 命令参数错误：${error.message}`;
  }
  return null;
}

function createPmCommandHandlers(options = {}) {
  const issueService = options.issueService;
  const permissionService = options.permissionService;
  const adapter = options.adapter;
  const clock = options.clock || Date.now;
  const split = options.split || splitWhatsAppText;
  const maxOutputLength = options.maxOutputLength;
  const attachmentsDir = options.attachmentsDir;
  const attachmentService = options.attachmentService || null;

  if (!issueService || typeof issueService.show !== 'function') {
    throw new TypeError('PM handlers require IssueService');
  }
  if (!permissionService || typeof permissionService.authorize !== 'function') {
    throw new TypeError('PM handlers require PermissionService');
  }
  if (!adapter || typeof adapter.sendParts !== 'function'
      || typeof adapter.sendArchivedAttachment !== 'function') {
    throw new TypeError('PM handlers require WhatsAppAdapter');
  }
  if (typeof attachmentsDir !== 'string' || !path.isAbsolute(attachmentsDir)) {
    throw new TypeError('PM handlers require an explicit absolute attachmentsDir');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  async function send(context, text) {
    const parts = split(text, maxOutputLength === undefined ? {} : { maxLength: maxOutputLength });
    return adapter.sendParts(context.normalized.chatJid, parts, {
      quotedMessageId: context.normalized.id,
    });
  }

  function base(context) {
    const identity = actorContext(context);
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('Injected PM handler clock must return a non-negative safe integer');
    }
    return { ...identity, now };
  }

  function wrap(operation) {
    return async (context) => {
      try {
        const outcome = await operation(context);
        if (outcome?.sentDirectly) return { ok: true, value: outcome.value };
        const receipts = await send(context, outcome.text);
        return { ok: true, value: outcome.value, receipts };
      } catch (error) {
        const message = knownErrorMessage(error);
        if (!message) throw error;
        const receipts = await send(context, message);
        return { ok: false, error, receipts };
      }
    };
  }

  const handlers = {
    help: wrap(async (context) => {
      const identity = base(context);
      permissionService.authorize('VIEW', identity);
      const args = context.parsed.args;
      if (args.length > 1 || (args[0] && !['member', 'eric', 'admin'].includes(args[0].toLowerCase()))) {
        throw new CommandInputError('INVALID_HELP_TOPIC', 'help 仅支持 member、eric 或 admin');
      }
      return { text: formatPmHelp(args[0]), value: null };
    }),

    list: wrap(async (context) => {
      const identity = base(context);
      if (context.parsed.args.length !== 1
          || context.parsed.args[0].toLowerCase() !== 'open') {
        throw new CommandInputError('INVALID_LIST', '用法：!pm list open');
      }
      const issues = issueService.listOpen(identity);
      return { text: formatOpenList(issues), value: issues };
    }),

    show: wrap(async (context) => {
      const identity = base(context);
      const args = [...context.parsed.args];
      let selectedPublicId = null;
      if (args[0] && !args[0].includes('=')) selectedPublicId = publicId(args.shift());
      const values = parseKeyValues(args, { allowed: ['deleted'] });
      const includeDeleted = booleanOption(values.deleted, 'deleted');
      const sourceWhatsappMessageId = selectedPublicId ? null : quoteSource(context);
      if (!selectedPublicId && !sourceWhatsappMessageId) {
        throw new CommandInputError(
          'SHOW_TARGET_REQUIRED',
          '用法：!pm show TV6，或引用工单来源消息后发送 !pm show'
        );
      }
      const detail = issueService.show({
        ...identity,
        publicId: selectedPublicId,
        sourceWhatsappMessageId,
        includeDeleted,
      });
      return { text: formatIssueDetail(detail), value: detail };
    }),

    find: wrap(async (context) => {
      const identity = base(context);
      const query = context.parsed.args.join(' ').trim();
      const sourceWhatsappMessageId = query ? null : quoteSource(context);
      if (!query && !sourceWhatsappMessageId) {
        throw new CommandInputError(
          'SEARCH_REQUIRED',
          '用法：!pm find <关键词>，或引用工单来源/回复后发送 !pm find'
        );
      }
      if (query.length > MAX_SEARCH_LENGTH) {
        throw new CommandInputError('SEARCH_TOO_LONG', `关键词不得超过 ${MAX_SEARCH_LENGTH} 字符`);
      }
      const issues = issueService.find({
        ...identity,
        query: query || undefined,
        sourceWhatsappMessageId,
      });
      return {
        text: formatSearchResults(query, issues, { sourceLookup: Boolean(sourceWhatsappMessageId) }),
        value: issues,
      };
    }),

    update: wrap(async (context) => {
      const identity = base(context);
      const [rawId, ...tokens] = context.parsed.args;
      const selectedPublicId = publicId(rawId);
      const values = parseKeyValues(tokens, {
        allowed: ['title', 'description', 'owner', 'owner-jid', 'reason', 'note'],
      });
      const changes = {};
      if (Object.hasOwn(values, 'title')) {
        if (!values.title.trim()) throw new CommandInputError('EMPTY_TITLE', 'title 不得为空');
        changes.title = values.title;
      }
      if (Object.hasOwn(values, 'description')) changes.description = values.description;
      if (Object.hasOwn(values, 'owner') && Object.hasOwn(values, 'owner-jid')) {
        throw new CommandInputError('DUPLICATE_OWNER', 'owner 与 owner-jid 只能使用一个');
      }
      if (Object.hasOwn(values, 'owner') || Object.hasOwn(values, 'owner-jid')) {
        changes.ownerJid = values.owner ?? values['owner-jid'];
      }
      if (Object.keys(changes).length === 0) {
        throw new CommandInputError('NO_CHANGES', '至少提供 title、description 或 owner');
      }
      const result = issueService.update({
        ...identity,
        publicId: selectedPublicId,
        changes,
        reason: values.reason || values.note || undefined,
        eventUid: stableUid(context, 'update'),
      });
      return { text: formatMutationSuccess('update', result), value: result };
    }),

    resolve: wrap(async (context) => {
      const identity = base(context);
      const [rawId, ...tokens] = context.parsed.args;
      const values = parseKeyValues(tokens, { allowed: ['reason', 'note'] });
      const result = issueService.resolve({
        ...identity,
        publicId: publicId(rawId),
        reason: values.reason || values.note || undefined,
        eventUid: stableUid(context, 'resolve'),
      });
      return { text: formatMutationSuccess('resolve', result), value: result };
    }),

    archive: null,
    delete: null,
    restore: null,

    'move-reply': wrap(async (context) => {
      const identity = base(context);
      const [rawSource, rawTarget, ...tokens] = context.parsed.args;
      if (!rawSource || !rawTarget) {
        throw new CommandInputError(
          'MOVE_TARGETS_REQUIRED',
          '用法：!pm move-reply TV1 TV2 [reply=3] [reason="..."]'
        );
      }
      const values = parseKeyValues(tokens, { allowed: ['reply', 'reason', 'note'] });
      const input = {
        ...identity,
        toPublicId: publicId(rawTarget, '目标工单编号'),
        reason: values.reason || values.note || undefined,
        eventUid: stableUid(context, 'move-reply', 'target'),
        sourceEventUid: stableUid(context, 'move-reply', 'source'),
      };
      if (PUBLIC_ID_PATTERN.test(String(rawSource).toUpperCase())) {
        input.fromPublicId = publicId(rawSource, '来源工单编号');
        if (values.reply) input.replyId = positiveInteger(values.reply, 'reply');
      } else {
        input.replyId = positiveInteger(rawSource, '回复编号');
        if (values.reply) {
          throw new CommandInputError('DUPLICATE_REPLY', '回复编号不能同时作为位置参数和 reply 参数');
        }
      }
      const result = issueService.moveReply(input);
      return { text: formatMutationSuccess('move-reply', result), value: result };
    }),

    'retry-file': wrap(async (context) => {
      if (!attachmentService || typeof attachmentService.retryIssue !== 'function') {
        throw new IssueDomainError('ATTACHMENT_UNAVAILABLE', 'Attachment retry service is unavailable');
      }
      const identity = base(context);
      const [rawId, ...extra] = context.parsed.args;
      if (extra.length > 0) throw new CommandInputError('TOO_MANY_ARGUMENTS', '附件重试不接受额外参数');
      const result = attachmentService.retryIssue({
        ...identity,
        publicId: publicId(rawId),
      });
      const queuedText = result.attachmentIds.length > 0
        ? `⏳ ${result.issue.public_id} 已排队重试 ${result.attachmentIds.length} 个附件：${result.attachmentIds.map((id) => `#${id}`).join('、')}`
        : null;
      const inFlightText = result.inFlightAttachmentIds?.length > 0
        ? `ℹ️ ${result.inFlightAttachmentIds.length} 个附件已有处理中任务（未重复排队）：${result.inFlightAttachmentIds.map((id) => `#${id}`).join('、')}`
        : null;
      const failedText = result.failedAdmissions?.length > 0
        ? `❌ ${result.failedAdmissions.length} 个附件未进入队列（保持可重试失败状态）：${result.failedAdmissions.map((failure) => `#${failure.attachmentId} ${failure.code}`).join('、')}`
        : null;
      const text = [queuedText, inFlightText, failedText].filter(Boolean).join('\n')
        || `ℹ️ ${result.issue.public_id} 没有可重试或待恢复的附件。`;
      return { text, value: result };
    }),

    'resend-file': wrap(async (context) => {
      const identity = base(context);
      const [rawId, rawAttachmentId, ...extra] = context.parsed.args;
      if (extra.length > 0) throw new CommandInputError('TOO_MANY_ARGUMENTS', '附件重发不接受额外参数');
      const result = issueService.attachmentForResend({
        ...identity,
        publicId: publicId(rawId),
        attachmentId: positiveInteger(rawAttachmentId, '附件编号'),
      });
      const filePath = resolveArchivedAttachmentPath(
        result.attachment.storage_key,
        attachmentsDir
      );
      const receipt = await adapter.sendArchivedAttachment(
        identity.chatJid,
        {
          path: filePath,
          displayName: result.attachment.display_name,
          mimeType: result.attachment.detected_mime,
          sizeBytes: result.attachment.size_bytes,
          attachmentId: result.attachment.id,
        },
        {
          caption: `📎 ${safeDisplayLine(result.issue.public_id)}｜${safeDisplayLine(result.attachment.display_name, { fallback: '未命名附件' })}`,
          quotedMessageId: context.normalized.id,
        }
      );
      return { sentDirectly: true, value: { ...result, receipt } };
    }),
  };

  for (const operation of ['archive', 'delete', 'restore']) {
    handlers[operation] = wrap(async (context) => {
      const identity = base(context);
      const [rawId, ...tokens] = context.parsed.args;
      const values = parseKeyValues(tokens, { allowed: ['reason', 'note'] });
      const result = issueService[operation]({
        ...identity,
        publicId: publicId(rawId),
        reason: values.reason || values.note || undefined,
        eventUid: stableUid(context, operation),
      });
      return { text: formatMutationSuccess(operation, result), value: result };
    });
  }

  // A descriptive alias is useful when reading detail output; both names enter
  // exactly the same authorization and adapter path.
  handlers.attachment = handlers['resend-file'];
  return Object.freeze(handlers);
}

module.exports = {
  CommandInputError,
  MAX_OPTION_VALUE_LENGTH,
  MAX_SEARCH_LENGTH,
  PUBLIC_ID_PATTERN,
  actorContext,
  createPmCommandHandlers,
  knownErrorMessage,
  parseKeyValues,
  publicId,
  quoteSource,
  resolveArchivedAttachmentPath,
  stableUid,
};
