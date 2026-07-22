'use strict';

const { requireInteger, requireTimestamp } = require('../db/repositories/shared');
const { buildPmReportModel } = require('./pm-report');
const { parseManualSummaryWindow } = require('./manual-window');
const { formatManualSummary, splitSummaryText } = require('./manual-summary-formatter');
const { requireTimezone } = require('./window');

function compactPmContext(pmReport) {
  const compact = (issues) => issues.slice(0, 20).map((issue) => ({
    publicId: issue.publicId,
    title: Array.from(String(issue.title || '')).slice(0, 160).join(''),
    status: issue.status,
  }));
  return {
    notice: '只读 PM 背景；不得据此增加聊天事实或执行任何状态修改。',
    changeEventCount: pmReport.changeEventCount,
    waitingCount: pmReport.queues.waitingTevau.length,
    waiting: compact(pmReport.queues.waitingTevau),
    repliedUnresolvedCount: pmReport.queues.repliedUnresolved.length,
    repliedUnresolved: compact(pmReport.queues.repliedUnresolved),
  };
}

class ManualSummaryService {
  constructor({
    repositories,
    conversationService,
    timezone = 'Asia/Kuala_Lumpur',
    maxHours = 168,
    maxSinceDays = 30,
    maxOutputLength = 3500,
  } = {}) {
    if (!repositories?.summaries?.latestSuccessfulAutomatic
        || !repositories?.issues || !repositories?.messages) {
      throw new TypeError('ManualSummaryService requires summary, issue, and message repositories');
    }
    if (!conversationService || typeof conversationService.build !== 'function') {
      throw new TypeError('conversationService.build is required');
    }
    this.repositories = repositories;
    this.conversationService = conversationService;
    this.timezone = requireTimezone(timezone);
    this.maxHours = maxHours;
    this.maxSinceDays = maxSinceDays;
    this.maxOutputLength = maxOutputLength;
  }

  async build({ chatId, tokens, now }) {
    const id = requireInteger(chatId, 'chatId', { min: 1 });
    const generatedAt = requireTimestamp(now, 'now');
    const window = parseManualSummaryWindow(tokens, {
      now: generatedAt,
      timezone: this.timezone,
      maxHours: this.maxHours,
      maxSinceDays: this.maxSinceDays,
      summaryRepository: this.repositories.summaries,
      chatId: id,
    });
    const pmReport = buildPmReportModel({
      repositories: this.repositories,
      chatId: id,
      window,
      now: generatedAt,
      timezone: this.timezone,
    });
    const conversation = await this.conversationService.build({
      chatId: id,
      window,
      pmContext: compactPmContext(pmReport),
    });
    const text = formatManualSummary({ window, conversation, pmReport });
    const parts = splitSummaryText(text, { maxLength: this.maxOutputLength });
    return Object.freeze({ window, conversation, pmReport, text, parts });
  }
}

module.exports = { ManualSummaryService, compactPmContext };
