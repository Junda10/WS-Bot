'use strict';

const { parseNamespacedCommand } = require('./parser');
const { formatPmHelp } = require('./pm-formatters');

const PM_HELP = formatPmHelp();

const SUMMARY_HELP = `🧾 *群聊摘要命令帮助*
!summary — 总结默认时间窗
!summary 4h — 总结最近 4 小时
!summary today — 总结今天
!summary yesterday — 总结昨天
!summary since "2026-07-20 09:00" — 从指定时间总结`;

function requireHandler(handler, name) {
  if (typeof handler !== 'function') throw new TypeError(`${name} handler must be a function`);
  return handler;
}

function sanitizeReflectedCommand(value, maxLength = 40) {
  const cleaned = Array.from(String(value || '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\n\r*_~`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()).slice(0, maxLength).join('');
  return cleaned || '(无法显示)';
}

function isRecognizedSummaryRequest(tokens) {
  if (tokens.length === 0) return true;
  if (tokens.length === 1) {
    return /^(?:today|yesterday|\d+[smhd])$/iu.test(tokens[0]);
  }
  return tokens.length === 2 && tokens[0].toLowerCase() === 'since'
    && tokens[1].trim().length > 0;
}

class CommandRouter {
  constructor(options = {}) {
    if (!options.permissionService
        || typeof options.permissionService.assertAuthorizedChat !== 'function') {
      throw new TypeError('CommandRouter requires PermissionService');
    }
    this.permissionService = options.permissionService;
    this.parse = options.parse || parseNamespacedCommand;
    this.parserOptions = options.parserOptions || {};
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new TypeError('CommandRouter clock must be a function');
    }
    this.clock = options.clock || Date.now;
    this.pmHandlers = new Map();
    this.summaryHandler = null;

    for (const [command, handler] of Object.entries(options.pmHandlers || {})) {
      this.registerPm(command, handler);
    }
    if (options.summaryHandler) this.setSummaryHandler(options.summaryHandler);
  }

  registerPm(command, handler) {
    const key = String(command || '').trim().toLowerCase();
    if (!key || /\s/u.test(key)) throw new TypeError('PM handler command must be one token');
    this.pmHandlers.set(key, requireHandler(handler, `PM ${key}`));
    return this;
  }

  setSummaryHandler(handler) {
    this.summaryHandler = requireHandler(handler, 'Summary');
    return this;
  }

  async _reply(message, text) {
    if (!message || typeof message.reply !== 'function') {
      throw new TypeError('Command route requires a message with reply()');
    }
    await message.reply(text);
  }

  async route(message, normalized, persisted = null) {
    const body = normalized?.body ?? message?.body;
    const parsed = this.parse(body, this.parserOptions);
    if (!parsed.matched) return Object.freeze({ handled: false, parsed });

    // Parsing is side-effect free. The configured, enabled chat boundary must
    // pass before any reply or injected business handler can run.
    const chat = this.permissionService.assertAuthorizedChat(normalized?.chatJid);

    if (!parsed.ok) {
      await this._reply(message, `⚠️ 命令格式错误：${parsed.error.message}\n发送 !${parsed.namespace} help 查看用法。`);
      return Object.freeze({ handled: true, kind: 'parse-error', parsed });
    }

    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('CommandRouter clock must return a non-negative safe integer');
    }
    const context = Object.freeze({
      message,
      normalized,
      persisted,
      parsed,
      chat,
      now,
      reply: (text) => this._reply(message, text),
    });

    if (parsed.namespace === 'pm') {
      if (!parsed.command) {
        await this._reply(message, `⚠️ 缺少 PM 子命令。\n\n${PM_HELP}`);
        return Object.freeze({ handled: true, kind: 'missing', parsed });
      }
      const handler = this.pmHandlers.get(parsed.command);
      if (handler) {
        const value = await handler(context);
        return Object.freeze({ handled: true, kind: 'handler', parsed, value });
      }
      if (parsed.command === 'help') {
        await this._reply(message, PM_HELP);
        return Object.freeze({ handled: true, kind: 'help', parsed });
      }
      await this._reply(
        message,
        `❓ 未知或尚未启用的 PM 命令：${sanitizeReflectedCommand(parsed.command)}\n发送 !pm help 查看可用命令。`
      );
      return Object.freeze({ handled: true, kind: 'unknown', parsed });
    }

    if (parsed.tokens.length === 1 && parsed.tokens[0].toLowerCase() === 'help') {
      await this._reply(message, SUMMARY_HELP);
      return Object.freeze({ handled: true, kind: 'help', parsed });
    }
    if (this.summaryHandler) {
      const value = await this.summaryHandler(context);
      return Object.freeze({ handled: true, kind: 'handler', parsed, value });
    }
    if (isRecognizedSummaryRequest(parsed.tokens)) {
      await this._reply(message, '⏳ 群聊摘要功能尚未启用，将在后续任务开放。');
      return Object.freeze({ handled: true, kind: 'missing-handler', parsed });
    }
    await this._reply(
      message,
      `❓ 未知或尚未启用的摘要参数：${sanitizeReflectedCommand(parsed.tokens[0])}\n发送 !summary help 查看用法。`
    );
    return Object.freeze({ handled: true, kind: 'unknown', parsed });
  }
}

function createCommandRouter(options) {
  return new CommandRouter(options);
}

module.exports = {
  CommandRouter,
  PM_HELP,
  SUMMARY_HELP,
  createCommandRouter,
  isRecognizedSummaryRequest,
  sanitizeReflectedCommand,
};
