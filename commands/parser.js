'use strict';

const DEFAULT_LIMITS = Object.freeze({
  maxInputLength: 4096,
  maxArgumentLength: 1000,
  maxArguments: 32,
});

const NAMESPACE_PATTERN = /^!(pm|summary)(?=$|\s)/iu;

function parserError(code, message, namespace) {
  return Object.freeze({
    matched: true,
    ok: false,
    namespace,
    error: Object.freeze({ code, message }),
  });
}

function normalizeLimit(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function resolveLimits(options = {}) {
  return {
    maxInputLength: normalizeLimit(
      options.maxInputLength,
      DEFAULT_LIMITS.maxInputLength,
      'maxInputLength'
    ),
    maxArgumentLength: normalizeLimit(
      options.maxArgumentLength,
      DEFAULT_LIMITS.maxArgumentLength,
      'maxArgumentLength'
    ),
    maxArguments: normalizeLimit(
      options.maxArguments,
      DEFAULT_LIMITS.maxArguments,
      'maxArguments'
    ),
  };
}

/**
 * Tokenize command arguments with small, deterministic shell-like rules:
 * - Unicode whitespace separates tokens outside quotes.
 * - Single and double quotes preserve whitespace and may form empty arguments.
 * - A backslash escapes the following Unicode code point inside or outside quotes.
 * - Adjacent quoted/unquoted fragments form one argument.
 */
function tokenizeArguments(input, options = {}) {
  const limits = resolveLimits(options);
  const characters = Array.from(String(input ?? ''));
  const tokens = [];
  let token = '';
  let tokenStarted = false;
  let quote = null;
  let escaped = false;

  function append(character) {
    token += character;
    tokenStarted = true;
    if (Array.from(token).length > limits.maxArgumentLength) {
      return parserError('ARGUMENT_TOO_LONG', '单个参数过长', options.namespace || null);
    }
    return null;
  }

  function finishToken() {
    if (!tokenStarted) return null;
    tokens.push(token);
    token = '';
    tokenStarted = false;
    if (tokens.length > limits.maxArguments) {
      return parserError('TOO_MANY_ARGUMENTS', '参数数量过多', options.namespace || null);
    }
    return null;
  }

  for (const character of characters) {
    if (escaped) {
      const error = append(character);
      if (error) return error;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
      } else {
        const error = append(character);
        if (error) return error;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      const error = finishToken();
      if (error) return error;
      continue;
    }
    const error = append(character);
    if (error) return error;
  }

  if (escaped) {
    return parserError('TRAILING_ESCAPE', '命令末尾的转义符不完整', options.namespace || null);
  }
  if (quote) {
    return parserError('UNCLOSED_QUOTE', '命令中的引号未闭合', options.namespace || null);
  }
  const error = finishToken();
  if (error) return error;
  return Object.freeze({ ok: true, tokens: Object.freeze(tokens) });
}

function parseNamespacedCommand(input, options = {}) {
  const limits = resolveLimits(options);
  if (typeof input !== 'string') return Object.freeze({ matched: false, ok: false });

  const leadingTrimmed = input.trimStart();
  const namespaceMatch = NAMESPACE_PATTERN.exec(leadingTrimmed);
  if (!namespaceMatch) return Object.freeze({ matched: false, ok: false });

  const namespace = namespaceMatch[1].toLowerCase();
  if (Array.from(leadingTrimmed).length > limits.maxInputLength) {
    return parserError('COMMAND_TOO_LONG', '命令内容过长', namespace);
  }

  const rawArguments = leadingTrimmed.slice(namespaceMatch[0].length);
  const tokenized = tokenizeArguments(rawArguments, { ...limits, namespace });
  if (!tokenized.ok) return tokenized;

  const tokens = tokenized.tokens;
  const command = namespace === 'pm' && tokens.length > 0
    ? tokens[0].toLowerCase()
    : null;
  const args = namespace === 'pm' ? tokens.slice(1) : tokens.slice();

  return Object.freeze({
    matched: true,
    ok: true,
    namespace,
    command,
    args: Object.freeze(args),
    tokens,
    raw: leadingTrimmed,
  });
}

module.exports = {
  DEFAULT_LIMITS,
  parseNamespacedCommand,
  tokenizeArguments,
};
