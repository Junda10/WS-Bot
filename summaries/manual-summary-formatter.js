'use strict';

const { DateTime } = require('luxon');
const {
  formatActor,
  formatDuration,
  safeDisplayLine,
} = require('../commands/pm-formatters');
const { requireTimezone } = require('./window');

const DEFAULT_SUMMARY_WHATSAPP_LIMIT = 3500;

const CHANGE_LABELS = Object.freeze({
  created: '新增',
  replies: '确认 Tevau 回复',
  resolved: '解决',
  archived: '归档',
  deleted: '删除',
  restored: '恢复',
  updated: '更新',
});

const PM_GAP_LABELS = Object.freeze({
  EVENT_SNAPSHOT_MISSING: '历史工单事件快照不完整',
  ISSUE_EXTRACTION_FALLBACK: '工单资料使用了确定性降级提取',
  ATTACHMENT_PARSE_PENDING: '工单附件仍待解析',
  ATTACHMENT_PARSE_FAILED: '工单附件解析失败',
  ATTACHMENT_SAVED_UNPARSED: '工单附件已保存但内容未解析',
});

function local(utcMs, timezone, format = 'yyyy-LL-dd HH:mm') {
  return DateTime.fromMillis(utcMs, { zone: timezone }).toFormat(format);
}

function semanticLines(values, empty) {
  if (!Array.isArray(values) || values.length === 0) return [empty];
  return values.map((value) => `- ${safeDisplayLine(value, { fallback: '（空白内容已忽略）' })}`);
}

function formatChange(event, timezone) {
  const publicId = safeDisplayLine(event.publicId, { fallback: `工单#${event.issueId}` });
  const title = safeDisplayLine(event.title, { fallback: '（历史标题缺失）' });
  const reason = safeDisplayLine(event.reason);
  return `- ${local(event.occurredAtUtcMs, timezone, 'LL-dd HH:mm')}｜${publicId}｜${title}${reason ? `｜${reason}` : ''}`;
}

function formatQueueIssue(issue, timezone) {
  const timing = issue.status === 'WAITING_TEVAU'
    ? `已等待 ${formatDuration(issue.waitingDurationMs)}`
    : `首响 ${formatDuration(issue.firstResponseDurationMs)}`;
  const attachments = issue.attachments;
  const indicators = [`附件 ${attachments.count}`];
  if (attachments.parsePendingCount) indicators.push(`待解析 ${attachments.parsePendingCount}`);
  if (attachments.parseFailedCount) indicators.push(`解析失败 ${attachments.parseFailedCount}`);
  if (attachments.savedUnparsedCount) indicators.push(`未解析 ${attachments.savedUnparsedCount}`);
  return [
    `${safeDisplayLine(issue.publicId, { fallback: '未知编号' })}｜${safeDisplayLine(issue.title, { fallback: '（无标题）' })}`,
    `  ${timing}｜建立 ${local(issue.createdAtUtcMs, timezone, 'LL-dd HH:mm')}｜${formatActor(issue.createdByJid)}`,
    `  ${indicators.join('｜')}`,
  ];
}

function formatManualSummary({
  window,
  conversation,
  pmReport,
  heading = '🧾 *群聊与 PM 摘要*',
  includeCurrentQueues = true,
}) {
  if (!window || !conversation || !pmReport) {
    throw new TypeError('window, conversation, and pmReport are required');
  }
  const timezone = requireTimezone(window.timezone || pmReport.timezone);
  const ai = conversation.ai;
  const semantic = ai.value;
  const hasEvidence = conversation.records.length > 0;
  const lines = [
    heading,
    '',
    '*时间窗口*',
    `${local(window.startUtcMs, timezone)} → ${local(window.endUtcMs, timezone)}（${timezone}）`,
    `半开区间：[开始, 结束)｜聊天 ${conversation.stats.chatMessageCount}｜已解析 Markdown ${conversation.stats.parsedMarkdownCount}`,
  ];

  const markdown = conversation.records.filter((record) => record.sourceType === 'MARKDOWN');
  if (markdown.length) {
    lines.push('Markdown 来源：');
    for (const record of markdown) {
      lines.push(`- ${record.filenames.map((name) => safeDisplayLine(name)).join('、')}｜${safeDisplayLine(record.provenance)}`);
    }
  }

  lines.push('', '*讨论重点*');
  if (!hasEvidence) {
    lines.push('该时段无新消息。');
  } else if (!ai.ok) {
    lines.push('AI 语义摘要暂不可用；未生成讨论重点。');
  } else {
    lines.push(...semanticLines(semantic.discussionPoints, '（未识别到明确讨论重点）'));
  }

  lines.push('', '*已作决定*');
  lines.push(...(ai.ok
    ? semanticLines(semantic.decisions, '（未识别到明确决定）')
    : ['（AI 不可用，未生成语义决定）']));

  lines.push('', '*待办事项 / 负责人*');
  if (!ai.ok || semantic.todos.length === 0) {
    lines.push(ai.ok ? '（未识别到明确待办）' : '（AI 不可用，未生成语义待办）');
  } else {
    for (const todo of semantic.todos) {
      lines.push(`- ${safeDisplayLine(todo.text)}｜负责人：${safeDisplayLine(todo.owner, { fallback: '未明确' })}`);
    }
  }

  if (pmReport.previousDayStats) {
    const stats = pmReport.previousDayStats;
    lines.push(
      '',
      `*昨日工单统计｜${local(stats.startUtcMs, timezone, 'yyyy-LL-dd')}*`,
      `新增：${stats.createdIssueCount}｜确认回复：${stats.confirmedReplyIssueCount} 个工单 / ${stats.confirmedReplyEventCount} 条事件`,
      `解决：${stats.resolvedIssueCount}｜日终仍未闭环：${stats.unresolvedAtEndIssueCount}`
    );
  }

  lines.push('', '*本窗口工单变化*');
  if (pmReport.changeEventCount === 0) {
    lines.push('（无工单变化）');
  } else {
    for (const [bucket, label] of Object.entries(CHANGE_LABELS)) {
      const events = pmReport.changes[bucket];
      if (!events.length) continue;
      lines.push(`${label}（${events.length}）`);
      lines.push(...events.map((event) => formatChange(event, timezone)));
    }
  }

  if (includeCurrentQueues) {
    lines.push('', `*全部等待 Tevau 回复（${pmReport.queues.waitingTevau.length}）*`);
    if (!pmReport.queues.waitingTevau.length) lines.push('（无）');
    for (const issue of pmReport.queues.waitingTevau) {
      lines.push(...formatQueueIssue(issue, timezone));
    }

    lines.push('', `*全部已回复但未解决（${pmReport.queues.repliedUnresolved.length}）*`);
    if (!pmReport.queues.repliedUnresolved.length) lines.push('（无）');
    for (const issue of pmReport.queues.repliedUnresolved) {
      lines.push(...formatQueueIssue(issue, timezone));
    }
  } else {
    lines.push('', '*当前未闭环队列*', '（合并补报末段统一列出，避免重复。）');
  }

  const uncertain = [];
  if (ai.ok) {
    for (const value of semantic.uncertainties) {
      uncertain.push(`AI：${safeDisplayLine(value)}`);
    }
  } else if (hasEvidence) {
    uncertain.push(`AI 群聊语义摘要不可用（${safeDisplayLine(ai.errorCode, { fallback: 'UNKNOWN' })}）；未以规则臆造语义要点。`);
  }
  if (ai.omittedChunkCount > 0) {
    uncertain.push(`证据超过模型调用上限，有 ${ai.omittedChunkCount} 个分块未交给 AI；语义摘要可能不完整。`);
  }
  for (const gap of conversation.attachmentGaps) {
    const state = gap.kind === 'MARKDOWN_PARSE_FAILED' ? '解析失败' : '仍待解析';
    uncertain.push(`Markdown「${safeDisplayLine(gap.filename)}」${state}，本次未纳入语义摘要。`);
  }
  if (includeCurrentQueues) {
    for (const item of pmReport.uncertainties) {
      uncertain.push(`${safeDisplayLine(item.publicId, { fallback: `工单#${item.issueId}` })}｜${safeDisplayLine(item.text, { fallback: '工单资料不确定' })}`);
    }
    for (const gap of pmReport.dataGaps) {
      const count = gap.count ? `（${gap.count}）` : '';
      uncertain.push(`${safeDisplayLine(gap.publicId, { fallback: `工单#${gap.issueId}` })}｜${PM_GAP_LABELS[gap.kind] || safeDisplayLine(gap.kind)}${count}`);
    }
  }

  lines.push('', `*不确定 / 待处理数据（${uncertain.length}）*`);
  if (!uncertain.length) lines.push('（无已知不确定项或待处理资料）');
  else lines.push(...uncertain.map((entry) => `- ${entry}`));

  return lines.join('\n');
}

function graphemePrefix(value, maxLength) {
  if (value.length <= maxLength) return value.length;
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' });
    let end = 0;
    for (const part of segmenter.segment(value)) {
      const candidate = part.index + part.segment.length;
      if (candidate > maxLength) break;
      end = candidate;
    }
    if (end > 0) return end;
  }
  let end = 0;
  for (const character of value) {
    if (end + character.length > maxLength) break;
    end += character.length;
  }
  return Math.max(1, end);
}

function splitSummaryText(value, options = {}) {
  const text = String(value || '');
  if (!text) throw new TypeError('summary text must be non-empty');
  const maxLength = options.maxLength ?? DEFAULT_SUMMARY_WHATSAPP_LIMIT;
  if (!Number.isSafeInteger(maxLength) || maxLength < 100 || maxLength > 4000) {
    throw new TypeError('maxLength must be an integer from 100 to 4000');
  }
  if (text.length <= maxLength) return Object.freeze([text]);

  const contentLimit = maxLength - 32;
  const chunks = [];
  let remaining = text;
  while (remaining) {
    let end = graphemePrefix(remaining, contentLimit);
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf('\n', end - 1);
      if (newline >= Math.floor(contentLimit * 0.45)) end = newline;
    }
    let chunk = remaining.slice(0, end).replace(/\n+$/u, '');
    if (!chunk) {
      end = graphemePrefix(remaining, contentLimit);
      chunk = remaining.slice(0, end);
    }
    chunks.push(chunk);
    remaining = remaining.slice(end).replace(/^\n+/u, '');
  }
  const total = chunks.length;
  return Object.freeze(chunks.map((chunk, index) => {
    const part = `📄 ${index + 1}/${total}\n${chunk}`;
    if (part.length > maxLength) throw new RangeError('summary part exceeds WhatsApp limit');
    return part;
  }));
}

module.exports = {
  CHANGE_LABELS,
  DEFAULT_SUMMARY_WHATSAPP_LIMIT,
  formatManualSummary,
  splitSummaryText,
};
