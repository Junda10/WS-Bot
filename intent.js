const { chatRaw } = require('./ai');

function extractJson(raw) {
  if (!raw) throw new Error('empty response');
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON found: ' + cleaned.slice(0, 200));
  return JSON.parse(match[0]);
}

async function classifyIntent(text, session) {
  const sessionBlock = session
    ? `\n\n当前对话上下文（之前已澄清的）：\nintent: ${session.intent}\nslots_filled: ${JSON.stringify(session.slots || {})}\n之前的提问: ${session.lastQuestion || '无'}\n用户这次回复: "${text}"\n\n请基于以上上下文重新评估。`
    : '';

  const system = `你是客服需求分析师。分析用户消息，识别意图（intent）并判断是否信息足够给出有用回答。

输出严格 JSON，不要任何解释或思考过程，不要 markdown 代码块。格式：
{
  "intent": "意图标识，例如 flight_search / hotel_search / product_inquiry / news_question / general_chat / other",
  "slots_filled": { "槽位名": "值", ... },
  "slots_missing": ["缺失的关键槽位1", "缺失的关键槽位2"],
  "confidence": 0.0到1.0,
  "ready_to_answer": true或false,
  "reasoning": "一句话解释"
}

规则：
- 槽位是给出有用回答所必需的信息（例如查机票需要：airline, depart_date, from_to）
- 闲聊/打招呼/感谢类消息: intent="general_chat", confidence=1.0, ready_to_answer=true, slots_missing=[]
- 信息越完整 confidence 越高；confidence>=0.9 时 ready_to_answer=true
- slots_missing 按重要性排序，最关键的在前
- 用中文填充槽位值${sessionBlock}`;

  const raw = await chatRaw(system, text, 1024);
  const parsed = extractJson(raw);
  // normalize
  parsed.confidence = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0));
  parsed.slots_filled = parsed.slots_filled || {};
  parsed.slots_missing = Array.isArray(parsed.slots_missing) ? parsed.slots_missing : [];
  parsed.ready_to_answer = !!parsed.ready_to_answer;
  parsed.intent = parsed.intent || 'unknown';
  return parsed;
}

async function generateOptions(intent, missingSlot, slotsFilled) {
  const system = `你是客服助手，需要向用户提一个具体的澄清问题，并给出 2-4 个最常见的选项让用户选择。

输出严格 JSON，不要解释或 markdown：
{
  "question": "一句话提问（不超过30字）",
  "options": ["选项1", "选项2", "选项3"]
}

规则：
- options 数量 2-4 个，必须是用户真实场景里最常见的选择
- 不要包含"其他"选项，调用方会自动追加
- 选项用中文，简短具体（例如 "AirAsia" 而非 "亚航 (AirAsia, 廉价航空)"）
- 问题要承接已知信息，不要重复问已经知道的`;

  const user = `intent: ${intent}\n已知信息: ${JSON.stringify(slotsFilled)}\n现在需要问的槽位: ${missingSlot}\n\n请生成提问和选项。`;
  const raw = await chatRaw(system, user, 512);
  const parsed = extractJson(raw);
  if (!parsed.question || !Array.isArray(parsed.options) || parsed.options.length === 0) {
    throw new Error('invalid generateOptions output');
  }
  // dedupe + cap at 4
  parsed.options = [...new Set(parsed.options.map(s => String(s).trim()).filter(Boolean))].slice(0, 4);
  parsed.options.push('其他（请直接说明）');
  return parsed;
}

module.exports = { classifyIntent, generateOptions };
