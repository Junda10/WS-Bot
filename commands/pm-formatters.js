'use strict';

const DEFAULT_WHATSAPP_TEXT_LIMIT = 4000;

const STATUS_LABELS = Object.freeze({
  WAITING_TEVAU: '等待 Tevau 回复',
  REPLIED: '已回复，待解决',
  RESOLVED: '已解决',
  ARCHIVED: '已归档',
});

const EVENT_LABELS = Object.freeze({
  CREATED: '建立',
  UPDATED: '更新',
  REPLY_CONFIRMED: '确认回复',
  RESOLVED: '解决',
  ARCHIVED: '归档',
  RESTORED: '恢复',
  DELETED: '删除',
  REPLY_MOVED: '移动回复',
});

const WHATSAPP_MARKUP_SUBSTITUTIONS = Object.freeze({
  '*': '＊',
  _: '＿',
  '~': '～',
  '`': 'ˋ',
});

/**
 * Make untrusted text safe to place on a structural WhatsApp output line.
 * Formatting metacharacters are made visible rather than interpreted, bidi and
 * control characters are removed, and every line break is collapsed.
 */
function safeDisplayLine(value, options = {}) {
  const fallback = options.fallback ?? '';
  const safe = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[*_~`]/gu, (character) => WHATSAPP_MARKUP_SUBSTITUTIONS[character])
    .replace(/\s+/gu, ' ')
    .trim();
  return safe || fallback;
}

/**
 * Preserve readable multiline evidence while fencing every untrusted line so
 * it cannot masquerade as another ticket, status, or timeline record.
 */
function formatDisplayBlock(value, options = {}) {
  const indent = options.indent ?? '  │ ';
  const fallback = options.fallback ?? '（无）';
  const lines = String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\p{Zl}\p{Zp}]/gu, '\n')
    .split('\n')
    .map((line) => safeDisplayLine(line));
  while (lines.length > 0 && !lines[0]) lines.shift();
  while (lines.length > 0 && !lines.at(-1)) lines.pop();
  const readable = lines.length > 0 ? lines : [safeDisplayLine(fallback, { fallback: '（无）' })];
  return readable.map((line) => `${indent}${line}`).join('\n');
}

function formatPmHelp(topic = '') {
  const selected = String(topic || '').trim().toLowerCase();
  const member = `🧭 *PM 命令帮助｜群成员*
!pm add — 引用来源消息或文档后直接建立 WAITING_TEVAU 工单
!pm list open — 查看全部未闭环工单（最久优先）
!pm show TV1 — 查看完整工单；也可引用来源消息后发送 !pm show
!pm find <关键词> — 搜索标题、问题和已确认回复
!pm update TV1 title="..." description="..." owner="JID" reason="..."
!pm resolve TV1 note="验证说明"
!pm resend-file TV1 <附件编号> — 在本群重发已归档附件
!pm attachment TV1 <附件编号> — resend-file 的同义别名
!pm retry-file TV1 — 重试该工单所有可重试的失败附件

参数含空格时使用单引号或双引号；key=value 每个键只能出现一次。`;
  const eric = `🧭 *PM 命令帮助｜Eric*
Eric 拥有群成员查询与更新权限。
!pm reply — 引用 Tevau 回复，建立 AI 建议与一次性确认会话
!pm confirm-reply <token> TV1 — 使用 token 确认
!pm confirm-reply TV1 — 必须引用 Bot 对应建议消息
!pm cancel <token> — 取消；或引用 Bot 对应建议后发送 !pm cancel`;
  const admin = `🧭 *PM 命令帮助｜管理员*
!pm archive TV1 reason="归档说明"
!pm delete TV1 reason="删除原因"
!pm restore TV1 reason="恢复原因"
!pm move-reply TV1 TV2 reason="纠错原因"
!pm move-reply TV1 TV2 reply=3 reason="多回复时指定回复编号"
!pm show TV1 deleted=true — 查看已软删除工单`;

  if (selected === 'member') return member;
  if (selected === 'eric') return eric;
  if (selected === 'admin') return admin;
  return `${member}\n\n${eric}\n\n${admin}\n\n分角色查看：!pm help member | eric | admin`;
}

function formatDuration(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 60_000) return '<1分钟';
  let minutes = Math.floor(value / 60_000);
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes || parts.length === 0) parts.push(`${minutes}分钟`);
  return parts.slice(0, 2).join('');
}

function formatTimestamp(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return '未知';
  return new Date(timestamp).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatActor(jid) {
  const value = String(jid || '').trim();
  if (!value) return '未知';
  const local = value.split('@')[0];
  if (/^\d+$/u.test(local)) return `群成员…${local.slice(-4)}`;
  const safe = safeDisplayLine(local.replace(/[^\p{L}\p{N}_.-]/gu, ''));
  return safe ? `群成员-${safe.slice(-8)}` : '群成员';
}

function statusLabel(status) {
  return STATUS_LABELS[status] || safeDisplayLine(status, { fallback: '未知' });
}

function formatOpenList(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return '✅ 当前没有未闭环工单。';
  }
  const lines = [`📋 *未闭环工单（${issues.length}）*`, '按等待最久优先：'];
  for (const issue of issues) {
    lines.push(
      '',
      `${safeDisplayLine(issue.public_id, { fallback: '未知编号' })}｜标题：${safeDisplayLine(issue.title, { fallback: '（无标题）' })}`,
      `状态：${statusLabel(issue.status)}｜等待：${formatDuration(issue.waitingDurationMs)}`,
      `建立：${formatActor(issue.created_by_jid)}｜附件：${issue.attachment_count ?? 0}`
    );
  }
  return lines.join('\n');
}

function formatSearchResults(query, issues, options = {}) {
  const sourceLookup = options.sourceLookup === true;
  if (!Array.isArray(issues) || issues.length === 0) {
    return sourceLookup
      ? '🔎 引用的来源消息没有关联到可见工单。'
      : `🔎 没有找到包含“${safeDisplayLine(query, { fallback: '（空）' })}”的可见工单。`;
  }
  const heading = sourceLookup
    ? `🔎 *引用来源关联工单（${issues.length}）*`
    : `🔎 *搜索“${safeDisplayLine(query, { fallback: '（空）' })}”（${issues.length}）*`;
  const lines = [heading];
  for (const issue of issues) {
    lines.push(
      '',
      `${safeDisplayLine(issue.public_id, { fallback: '未知编号' })}｜标题：${safeDisplayLine(issue.title, { fallback: '（无标题）' })}`,
      `${statusLabel(issue.status)}｜等待/首响：${formatDuration(issue.waitingDurationMs)}`
    );
  }
  return lines.join('\n');
}

function formatAttachment(attachment, publicId) {
  const mime = safeDisplayLine(attachment.detected_mime, { fallback: '类型待检测' });
  const size = Number.isSafeInteger(attachment.size_bytes)
    ? `${attachment.size_bytes} bytes`
    : '大小未知';
  const availability = attachment.storage_key ? '可重发' : '尚无归档文件';
  const displayName = safeDisplayLine(attachment.display_name, { fallback: '未命名附件' });
  const processingStatus = safeDisplayLine(attachment.processing_status, { fallback: '状态未知' });
  const failure = attachment.processing_status === 'FAILED'
    ? `\n  失败：${safeDisplayLine(attachment.last_error_code, { fallback: 'PROCESSING_FAILED' })}｜${attachment.retryable ? '可重试' : '不可重试'}`
    : '';
  return `#${attachment.id} ${displayName}\n  ${mime}｜${size}｜${processingStatus}｜${availability}${failure}\n  重发：!pm resend-file ${safeDisplayLine(publicId)} ${attachment.id}`;
}

function formatIssueDetail(detail) {
  const { issue } = detail;
  const replies = Array.isArray(detail.replies) ? detail.replies : [];
  const attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
  const events = Array.isArray(detail.events) ? detail.events : [];
  const lastEvent = events.at(-1);
  const firstResponse = issue.firstResponseDurationMs === null
    ? '尚未收到已确认回复'
    : formatDuration(issue.firstResponseDurationMs);
  const waitingLabel = issue.first_replied_at === null ? '当前等待' : '首响等待';
  const sourceId = safeDisplayLine(
    issue.source_whatsapp_message_id || detail.sourceMessage?.whatsapp_message_id,
    { fallback: '无' }
  );
  const deleted = issue.deleted_at === null ? '' : `\n删除时间：${formatTimestamp(issue.deleted_at)}`;
  const lines = [
    `🗂️ *${safeDisplayLine(issue.public_id, { fallback: '未知编号' })}｜${safeDisplayLine(issue.title, { fallback: '（无标题）' })}*`,
    `状态：${statusLabel(issue.status)}${issue.deleted_at === null ? '' : '（已软删除）'}`,
    `负责人：${issue.owner_jid ? formatActor(issue.owner_jid) : '未指定'}`,
    `建立：${formatTimestamp(issue.created_at)}｜${formatActor(issue.created_by_jid)}`,
    `更新：${formatTimestamp(issue.updated_at)}｜修订 ${issue.revision}`,
    `${waitingLabel}：${formatDuration(issue.waitingDurationMs)}｜首次响应：${firstResponse}`,
    `来源消息：${sourceId}`,
    `最近修改者：${lastEvent ? formatActor(lastEvent.actor_jid) : formatActor(issue.created_by_jid)}${deleted}`,
    '',
    '*问题描述*',
    formatDisplayBlock(issue.description, { fallback: '（无描述）' }),
    '',
    `*Tevau 回复（${replies.length}）*`,
  ];

  if (replies.length === 0) {
    lines.push('（尚无已确认回复）');
  } else {
    for (const reply of replies) {
      lines.push(
        `#${reply.id}｜${formatTimestamp(reply.confirmed_at)}｜${formatActor(reply.confirmed_by_jid)}`,
        formatDisplayBlock(reply.reply_text, { fallback: '（无回复正文）' }),
        `来源：${safeDisplayLine(reply.source_whatsapp_message_id, { fallback: '无' })}`,
        ''
      );
    }
  }

  lines.push(`*附件（${attachments.length}）*`);
  if (attachments.length === 0) {
    lines.push('（无工单附件）');
  } else {
    for (const attachment of attachments) {
      lines.push(formatAttachment(attachment, issue.public_id), '');
    }
  }

  lines.push(`*时间线（${events.length}）*`);
  for (const event of events) {
    lines.push(
      `${formatTimestamp(event.occurred_at)}｜${EVENT_LABELS[event.event_type] || safeDisplayLine(event.event_type, { fallback: '未知事件' })}`,
      `操作者：${formatActor(event.actor_jid)}｜说明：`,
      formatDisplayBlock(event.reason, { fallback: '无' })
    );
  }
  return lines.join('\n').trimEnd();
}

function safeMachineCode(value, fallback) {
  const code = String(value || '');
  return /^[A-Z][A-Z0-9_:-]{0,99}$/u.test(code)
    ? code
    : safeDisplayLine(code, { fallback });
}

function formatAddAttachmentStatus(attachment) {
  const name = safeDisplayLine(attachment.displayName, { fallback: `附件 #${attachment.id}` });
  const parse = safeMachineCode(attachment.parseStatus, 'PENDING');
  const processing = safeMachineCode(attachment.processingStatus, 'PENDING');
  const promotion = safeMachineCode(attachment.promotion, 'NOT_ARCHIVED');
  const error = attachment.errorCode
    ? `｜失败=${safeMachineCode(attachment.errorCode, 'PROCESSING_FAILED')}${attachment.retryable ? '（可重试）' : '（不可重试）'}`
    : '';
  return `- ${name}：处理=${processing}｜解析=${parse}｜归档=${promotion}${error}`;
}

function formatAddSuccess(result) {
  const issue = result.issue;
  const attachments = Array.isArray(result.attachments) ? result.attachments : [];
  const uncertainties = Array.isArray(result.uncertainties) ? result.uncertainties : [];
  const lines = [
    `✅ *已建立 ${safeDisplayLine(issue.public_id)}｜${safeDisplayLine(issue.title, { fallback: '资料待补充' })}*${result.replayed ? '（幂等重放）' : ''}`,
    `状态：${STATUS_LABELS[issue.status] ? issue.status : safeDisplayLine(issue.status)}（${statusLabel(issue.status)}）`,
    `记录时间：${formatTimestamp(issue.created_at)}`,
    '',
    '*提取的问题描述*',
    formatDisplayBlock(issue.description, { fallback: '资料待补充' }),
    '',
    `*附件状态（${attachments.length}）*`,
    ...(attachments.length > 0 ? attachments.map(formatAddAttachmentStatus) : ['- 无附件']),
    '',
    '*不确定项*',
    ...(uncertainties.length > 0
      ? uncertainties.map((entry) => `- ${safeDisplayLine(entry, { fallback: '未说明' })}`)
      : ['- 无明确不确定项']),
  ];
  if (attachments.some((attachment) => attachment.promotion === 'RECOVERABLE_PARTIAL')) {
    lines.push('', '⚠️ 工单已建立，但附件永久归档处于可恢复部分状态；再次发送同一命令或使用 !pm retry-file 可重试，不会新建工单。');
  }
  lines.push(
    '',
    '若提取内容不准确，请修正：',
    `!pm update ${safeDisplayLine(issue.public_id)} description="..."`
  );
  return lines.join('\n');
}

function formatReplySuggestion(result) {
  const session = result.session;
  const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 3) : [];
  const confidence = { low: '低', medium: '中', high: '高' }[session.ai_confidence] || '低';
  const selected = session.ai_selected_public_id || '无可靠单一匹配';
  const aiUnavailable = ['FAILED', 'INVALID', 'PROCESSING'].includes(session.ai_status)
    ? '⚠️ AI 未产生可靠结果，以下为确定性安全候选；不会自动写入回复。'
    : (session.ai_status === 'NO_MATCH'
      ? 'ℹ️ AI 未找到可靠单一匹配；请 Eric 从候选手动选择。'
      : '即使信心高，也必须由 Eric 明确确认。');
  const lines = [
    '🔎 *Tevau 回复匹配建议（待 Eric 确认）*',
    `建议：${safeDisplayLine(selected)}`,
    `理由：${safeDisplayLine(String(session.ai_reason || '未提供').slice(0, 600), { fallback: '未提供' })}`,
    `信心：${confidence}`,
    aiUnavailable,
    '',
    `*候选（${candidates.length}，最多 3 个）*`,
  ];
  for (const candidate of candidates) {
    lines.push(
      `${candidate.position}. ${safeDisplayLine(candidate.public_id)}｜${safeDisplayLine(candidate.title, { fallback: '（无标题）' })}`,
      `   ${safeDisplayLine(String(candidate.reason || '').slice(0, 300), { fallback: '确定性候选' })}`
    );
  }
  lines.push(
    '',
    `会话 token：${safeDisplayLine(session.token)}`,
    `有效至：${formatTimestamp(session.expires_at)}`,
    'token 是短时一次性确认凭据；明文显示仅用于发送失败或重启后的恢复，到期即失效。',
    '确认（推荐携带 token）：',
    `!pm confirm-reply ${safeDisplayLine(session.token)} ${safeDisplayLine(session.ai_selected_public_id || candidates[0]?.public_id || 'TVn')}`,
    '也可引用本条 Bot 建议，仅发送：!pm confirm-reply TVn',
    `取消：!pm cancel ${safeDisplayLine(session.token)}（或引用本条发送 !pm cancel）`
  );
  return lines.join('\n');
}

function formatReplyAlreadyPrompted(result) {
  return `ℹ️ 此 Tevau 回复已有待确认会话，未重复调用 AI。\ntoken：${safeDisplayLine(result.session.token)}\n请使用：!pm confirm-reply ${safeDisplayLine(result.session.token)} TVn`;
}

function formatReplyConfirmed(result) {
  const issue = result.issue;
  return [
    `✅ *已确认 Tevau 回复 → ${safeDisplayLine(issue.public_id)}*${result.replayed ? '（幂等重放）' : ''}`,
    `标题：${safeDisplayLine(issue.title, { fallback: '（无标题）' })}`,
    `状态：${statusLabel(issue.status)}`,
    `首次响应耗时：${formatDuration(result.firstResponseDurationMs)}`,
    '',
    '*回复快照*',
    formatDisplayBlock(String(result.reply.reply_text || '').slice(0, 1200), { fallback: '（无回复正文）' }),
    '',
    '下一步：商户验证恢复后发送：',
    `!pm resolve ${safeDisplayLine(issue.public_id)} note="验证说明"`,
  ].join('\n');
}

function formatReplyCancelled(result) {
  return `✅ 已取消回复匹配会话 ${safeDisplayLine(result.session.token)}${result.session.replayed ? '（已取消）' : ''}；未写入任何工单回复。`;
}

function formatMutationSuccess(operation, result) {
  const issue = result.issue || result.targetIssue || result.record || result;
  const labels = {
    update: '已更新',
    resolve: '已标记解决',
    archive: '已归档',
    delete: '已软删除',
    restore: '已恢复',
    'move-reply': '已移动回复',
  };
  if (operation === 'move-reply') {
    return `✅ ${labels[operation]}：#${result.reply.id} → ${safeDisplayLine(result.targetIssue.public_id)}\n来源工单：${safeDisplayLine(result.sourceIssue.public_id)}`;
  }
  return `✅ ${labels[operation] || '操作完成'} ${safeDisplayLine(issue.public_id)}\n状态：${statusLabel(issue.status)}｜修订：${issue.revision}`;
}

function safeBoundary(text, start, preferredEnd) {
  let end = preferredEnd;
  if (end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
      end -= 1;
    }
  }
  if (end <= start) end = preferredEnd;
  return end;
}

function splitRaw(text, chunkLimit) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = safeBoundary(text, start, Math.min(text.length, start + chunkLimit));
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start + Math.floor(chunkLimit * 0.5)) end = newline + 1;
    }
    chunks.push(text.slice(start, end).replace(/\n+$/u, ''));
    start = end;
    while (text[start] === '\n') start += 1;
  }
  return chunks;
}

function splitWhatsAppText(value, options = {}) {
  const text = String(value || '');
  if (!text) throw new TypeError('text must be non-empty');
  const maxLength = options.maxLength ?? DEFAULT_WHATSAPP_TEXT_LIMIT;
  if (!Number.isSafeInteger(maxLength) || maxLength < 100) {
    throw new TypeError('maxLength must be a safe integer >= 100');
  }
  if (text.length <= maxLength) return Object.freeze([text]);

  // Reserve enough room for deterministic part labels, including very large N.
  const chunks = splitRaw(text, maxLength - 32);
  const total = chunks.length;
  return Object.freeze(chunks.map((chunk, index) => {
    const prefix = `📄 ${index + 1}/${total}\n`;
    const part = prefix + chunk;
    if (part.length > maxLength) throw new RangeError('part label exceeded reserved output space');
    return part;
  }));
}

module.exports = {
  DEFAULT_WHATSAPP_TEXT_LIMIT,
  EVENT_LABELS,
  STATUS_LABELS,
  formatActor,
  formatAddSuccess,
  formatDisplayBlock,
  formatDuration,
  formatIssueDetail,
  formatMutationSuccess,
  formatOpenList,
  formatPmHelp,
  formatReplyAlreadyPrompted,
  formatReplyCancelled,
  formatReplyConfirmed,
  formatReplySuggestion,
  formatSearchResults,
  formatTimestamp,
  safeDisplayLine,
  splitWhatsAppText,
  statusLabel,
};
