'use strict';

const { DateTime } = require('luxon');
const { requireInteger, requireTimestamp } = require('../db/repositories/shared');
const { buildPmReportModel } = require('./pm-report');
const { compactPmContext } = require('./manual-summary-service');
const { formatManualSummary, splitSummaryText } = require('./manual-summary-formatter');
const { requireTimezone } = require('./window');

function localRange(window, timezone) {
  const format = (value) => DateTime.fromMillis(value, { zone: timezone })
    .toFormat('yyyy-LL-dd HH:mm');
  return `${format(window.startUtcMs)} → ${format(window.endUtcMs)}`;
}

function constituentWindow(window) {
  return {
    ...window,
    startUtcMs: window.windowStart ?? window.startUtcMs,
    endUtcMs: window.windowEnd ?? window.endUtcMs,
    scheduledForUtcMs: window.scheduledFor ?? window.scheduledForUtcMs,
  };
}

class ScheduledSummaryService {
  constructor({
    repositories,
    conversationService,
    timezone = 'Asia/Kuala_Lumpur',
    maxOutputLength = 3400,
  } = {}) {
    if (!repositories?.issues || !repositories?.messages) {
      throw new TypeError('ScheduledSummaryService requires issue and message repositories');
    }
    if (!conversationService || typeof conversationService.build !== 'function') {
      throw new TypeError('conversationService.build is required');
    }
    this.repositories = repositories;
    this.conversationService = conversationService;
    this.timezone = requireTimezone(timezone);
    this.maxOutputLength = maxOutputLength;
  }

  async _buildWindow({ chatId, window, now }) {
    const pmReport = buildPmReportModel({
      repositories: this.repositories,
      chatId,
      window,
      now,
      timezone: this.timezone,
    });
    const conversation = await this.conversationService.build({
      chatId,
      window,
      pmContext: compactPmContext(pmReport),
    });
    return { window, conversation, pmReport };
  }

  async build({ chatId, window, now, delayed = false, constituentWindows = [] }) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const generatedAt = requireTimestamp(now, 'now');
    const combined = constituentWindows.length > 1;

    if (!combined) {
      const segment = await this._buildWindow({ chatId: id, window, now: generatedAt });
      const heading = delayed
        ? `⏰ *延迟补报｜原定 ${window.slot || '自动'}*`
        : `🧾 *定时群聊与 PM 摘要｜${window.slot || '自动'}*`;
      const text = formatManualSummary({ ...segment, heading });
      const parts = splitSummaryText(text, { maxLength: this.maxOutputLength });
      return Object.freeze({ ...segment, text, parts });
    }

    // Missing automatic windows are not necessarily contiguous. Building one
    // broad first→last range would duplicate evidence from a successful gap.
    // Build every actual missing half-open window independently, then seal one
    // combined WhatsApp manifest. The current PM queue is printed only once.
    const normalized = constituentWindows.map(constituentWindow);
    const segments = [];
    for (const item of normalized) {
      segments.push(await this._buildWindow({ chatId: id, window: item, now: generatedAt }));
    }

    const heading = `⏰ *延迟合并补报｜${segments.length} 个漏报时段*`;
    const coverage = normalized.map((item) => (
      `- ${item.reportType.replace('AUTO_', '')}:00｜${localRange(item, this.timezone)}`
    )).join('\n');
    const bodies = segments.map((segment, index) => formatManualSummary({
      ...segment,
      heading: `🕒 *漏报窗口 ${index + 1}/${segments.length}｜${segment.window.slot || '自动'}*`,
      includeCurrentQueues: index === segments.length - 1,
    }));
    const text = `${heading}\n*本报告一次覆盖以下漏报窗口（不会逐份补发）：*\n${coverage}\n\n${bodies.join('\n\n──────────\n\n')}`;
    const parts = splitSummaryText(text, { maxLength: this.maxOutputLength });
    return Object.freeze({
      window,
      conversation: segments.at(-1).conversation,
      pmReport: segments.at(-1).pmReport,
      segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
      text,
      parts,
    });
  }
}

module.exports = { ScheduledSummaryService, constituentWindow, localRange };
