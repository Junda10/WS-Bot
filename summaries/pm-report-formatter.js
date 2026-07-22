'use strict';

const { DateTime } = require('luxon');
const {
  formatActor,
  formatDuration,
  safeDisplayLine,
} = require('../commands/pm-formatters');
const { requireTimezone } = require('./window');

const CHANGE_LABELS = Object.freeze({
  created: '新增',
  replies: '确认 Tevau 回复',
  resolved: '解决',
  archived: '归档',
  deleted: '删除',
  restored: '恢复',
  updated: '更新',
});

const GAP_LABELS = Object.freeze({
  EVENT_SNAPSHOT_MISSING: '历史事件快照缺少编号或标题',
  ISSUE_EXTRACTION_FALLBACK: '建单提取使用确定性降级资料',
  ATTACHMENT_PARSE_PENDING: '附件仍待解析',
  ATTACHMENT_PARSE_FAILED: '附件解析失败',
  ATTACHMENT_SAVED_UNPARSED: '附件已保存但无法解析',
});

function localDateTime(utcMs, timezone, format = 'yyyy-LL-dd HH:mm') {
  if (!Number.isSafeInteger(utcMs) || utcMs < 0) return '时间未知';
  const zone = requireTimezone(timezone);
  const value = DateTime.fromMillis(utcMs, { zone });
  return value.isValid ? value.toFormat(format) : '时间未知';
}

function formatAttachmentIndicators(attachments) {
  const indicators = [`附件 ${attachments.count}`];
  if (attachments.parsePendingCount) indicators.push(`待解析 ${attachments.parsePendingCount}`);
  if (attachments.parseFailedCount) indicators.push(`解析失败 ${attachments.parseFailedCount}`);
  if (attachments.savedUnparsedCount) indicators.push(`未解析 ${attachments.savedUnparsedCount}`);
  return indicators.join('｜');
}

function formatQueueIssue(issue, timezone) {
  const duration = issue.status === 'WAITING_TEVAU'
    ? `已等待 ${formatDuration(issue.waitingDurationMs)}`
    : `首响 ${formatDuration(issue.firstResponseDurationMs)}`;
  return [
    `${safeDisplayLine(issue.publicId, { fallback: '未知编号' })}｜${safeDisplayLine(issue.title, { fallback: '（无标题）' })}`,
    `  ${duration}｜建立 ${localDateTime(issue.createdAtUtcMs, timezone, 'LL-dd HH:mm')}｜${formatActor(issue.createdByJid)}`,
    `  ${formatAttachmentIndicators(issue.attachments)}`,
  ];
}

function formatChange(event, timezone) {
  const reason = safeDisplayLine(event.reason);
  return `${localDateTime(event.occurredAtUtcMs, timezone, 'LL-dd HH:mm')}｜${safeDisplayLine(event.publicId, { fallback: `工单#${event.issueId}` })}｜${safeDisplayLine(event.title, { fallback: '（历史标题缺失）' })}${reason ? `｜${reason}` : ''}`;
}

function formatPmReport(model, options = {}) {
  if (!model || model.source !== 'SQLITE_DETERMINISTIC') {
    throw new TypeError('A deterministic PM report model is required');
  }
  const timezone = requireTimezone(model.timezone);
  const lines = [
    `📊 *PM 报告｜${localDateTime(model.window.startUtcMs, timezone)} → ${localDateTime(model.window.endUtcMs, timezone)}*`,
    `时区：${timezone}｜非命令消息：${model.messageCount}｜工单变化：${model.changeEventCount}`,
  ];
  if (options.aiUnavailable === true) {
    lines.push('⚠️ AI 群聊摘要不可用；以下 PM 数据仍由 SQLite 确定性生成。');
  } else {
    lines.push('ℹ️ 以下 PM 数据未调用 AI，由 SQLite 确定性生成。');
  }

  lines.push('', '*本窗口工单变化*');
  if (model.changeEventCount === 0) {
    lines.push('（本窗口无工单变化）');
  } else {
    for (const [bucket, label] of Object.entries(CHANGE_LABELS)) {
      const events = model.changes[bucket];
      if (!events.length) continue;
      lines.push(`${label}（${events.length}）`);
      for (const event of events) lines.push(`- ${formatChange(event, timezone)}`);
    }
  }

  if (model.previousDayStats) {
    const stats = model.previousDayStats;
    lines.push(
      '',
      `*昨日工单统计｜${localDateTime(stats.startUtcMs, timezone, 'yyyy-LL-dd')}*`,
      `新增：${stats.createdIssueCount}｜确认回复：${stats.confirmedReplyIssueCount} 个工单 / ${stats.confirmedReplyEventCount} 条事件`,
      `解决：${stats.resolvedIssueCount}｜日终仍未闭环：${stats.unresolvedAtEndIssueCount}`
    );
  }

  lines.push('', `*等待 Tevau 回复（${model.queues.waitingTevau.length}）*`);
  if (!model.queues.waitingTevau.length) {
    lines.push('（无）');
  } else {
    for (const issue of model.queues.waitingTevau) {
      lines.push(...formatQueueIssue(issue, timezone));
    }
  }

  lines.push('', `*已回复、待解决（${model.queues.repliedUnresolved.length}）*`);
  if (!model.queues.repliedUnresolved.length) {
    lines.push('（无）');
  } else {
    for (const issue of model.queues.repliedUnresolved) {
      lines.push(...formatQueueIssue(issue, timezone));
    }
  }

  lines.push('', `*不确定项（${model.uncertainties.length}）*`);
  if (!model.uncertainties.length) {
    lines.push('（无已记录不确定项）');
  } else {
    for (const uncertainty of model.uncertainties) {
      lines.push(`- ${safeDisplayLine(uncertainty.publicId)}｜${safeDisplayLine(uncertainty.text, { fallback: '未说明' })}`);
    }
  }

  lines.push('', `*数据缺口（${model.dataGaps.length}）*`);
  if (!model.dataGaps.length) {
    lines.push('（无已知数据缺口）');
  } else {
    for (const gap of model.dataGaps) {
      const count = gap.count ? `（${gap.count}）` : '';
      lines.push(`- ${safeDisplayLine(gap.publicId, { fallback: `工单#${gap.issueId}` })}｜${GAP_LABELS[gap.kind] || safeDisplayLine(gap.kind)}${count}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  CHANGE_LABELS,
  formatPmReport,
  localDateTime,
};
