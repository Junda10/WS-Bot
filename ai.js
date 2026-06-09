const axios = require('axios');

const API_KEY = process.env.OPENROUTER_API_KEY;

const MODELS = [
  'openai/gpt-oss-120b:free',
  'z-ai/glm-4.5-air:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

// Core model-chain call. chat() and chatRaw() are thin wrappers over this.
async function _chat(systemPrompt, userMessage, { maxTokens = 2048, timeout = 45000, clean = true, label = '' } = {}) {
  const tag = label ? `[${label}] ` : '';
  for (const model of MODELS) {
    try {
      console.log(`🤖 ${tag}尝试模型: ${model}`);
      const start = Date.now();
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout,
        }
      );
      const msg = res.data.choices[0].message;
      let content = msg.content || msg.reasoning || '';
      content = clean ? cleanAIResponse(content) : content.trim();
      if (content) {
        console.log(`✅ ${tag}${model} 成功 (${Date.now() - start}ms${clean ? '' : `, ${content.length} chars`})`);
        return content;
      }
      console.log(`⚠️ ${tag}${model} 返回空内容，跳过`);
    } catch (err) {
      console.error(`❌ ${tag}${model} 失败: ${err.response?.data?.error?.message || err.message}`);
    }
  }
  console.error(`❌ ${tag}所有模型都失败了`);
  return null;
}

async function chat(systemPrompt, userMessage) {
  return _chat(systemPrompt, userMessage, { maxTokens: 2048, timeout: 45000, clean: true });
}

function cleanAIResponse(text) {
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/, '').replace(/```/, ''));
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => /^[📰📅🌐🚗🏠]/.test(l.trim()));
  if (startIdx > 0) text = lines.slice(startIdx).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

async function summarizeNews(rawNews) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const today = `${yyyy}-${mm}-${dd} ${days[now.getDay()]}`;

  const system = `你是一个专业的中文新闻编辑。今天是 ${today}。

任务：将用户提供的新闻整理成简洁清晰的每日新闻摘要。

格式要求（严格遵守）：
1. 开头写: 📰 *每日新闻摘要*
2. 第二行写: 📅 ${today}
3. 空一行后按分类整理新闻
4. 每个分类用原有的emoji标题（🤖 AI科技、🌍世界新闻、🚗汽车、🏠房产）
5. 每条新闻格式：
   序号. *新闻标题中文翻译*
   简短总结（1句话，最多30字）
   🔗 链接

重要规则：
- 每条新闻必须保留🔗链接，链接单独一行
- 全部用中文，英文标题翻译成中文
- 不要输出思考过程，直接输出新闻摘要
- 不要加任何解释或前言`;

  return await chat(system, rawNews);
}

async function smartReply(userMessage, userContext = '') {
  const contextBlock = userContext
    ? `\n\n你对这个用户的了解：\n${userContext}\n根据这些了解来个性化你的回复，但不要直接说"我知道你喜欢…"，自然地融入对话。`
    : '';

  const system = `你是 Terry，一个专业的新闻类 AI 主播。\n你的身份：新闻类主播，擅长 AI科技、世界时事、汽车、房产等领域的新闻播报和解读。\n你的性格：专业但亲和，幽默风趣，热心助人，像一个懂很多的朋友。\n当用户问你是谁时，介绍自己是“Terry，你的AI新闻主播”，并简短说明你可以提供新闻播报、解答问题、聊天等服务。\n回复要简洁（1-3句话），自然，像朋友聊天一样。\n如果用户有任何需求，尽力帮忙完成。\n不要输出思考过程，直接回复。${contextBlock}`;

  return await chat(system, userMessage);
}

async function extractPreference(userMessage) {
  const system = `分析这条消息，提取用户的偏好或个人信息。\n只输出JSON格式，不要其他内容。\n格式：{"topic": "话题分类", "fact": "关于用户的事实或null", "sentiment": "positive/negative/neutral"}\n话题分类只能是：tech/car/property/world/ai/lifestyle/other\n如果无法提取事实，fact设为null。`;

  try {
    const raw = await chat(system, userMessage);
    if (!raw) return null;
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}


async function chatRaw(systemPrompt, userMessage, maxTokens = 4096) {
  return _chat(systemPrompt, userMessage, { maxTokens, timeout: 90000, clean: false, label: 'raw' });
}

async function answerWithSlots(intent, slots, userText, memoryContext = '') {
  const memBlock = memoryContext ? `\n\n关于这个用户你已经知道的：\n${memoryContext}` : '';
  const slotBlock = Object.keys(slots || {}).length
    ? `\n已澄清的细节：${Object.entries(slots).map(([k, v]) => `${k}=${v}`).join('\u3001')}`
    : '';

  const system = `你是 Terry，新闻类 AI 主播，也是热心的助手。
用户的需求已经通过多轮澄清明确了，现在请基于以下信息给出简洁有用的回复（1-3 句话，自然像朋友聊天）：
- 用户意图: ${intent}${slotBlock}
- 用户最初/最近一次原话: "${userText}"${memBlock}

规则：
- 不要重复问已知的信息
- 如果是查询类需求，直接给推荐网址或要点
- 不要输出思考过程，直接回复`;

  return await chat(system, userText);
}

module.exports = { chat, chatRaw, summarizeNews, smartReply, extractPreference, answerWithSlots };
