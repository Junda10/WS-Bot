const axios = require('axios');

const API_KEY = process.env.OPENROUTER_API_KEY;

// OpenRouter free-model fallback chain.
// Keep this list fresh because free model IDs are occasionally removed/renamed.
// OPENROUTER_MODEL can be set in .env to force a preferred first choice.
const DEFAULT_MODELS = [
  // Prefer the newest high-quality general model; code-only models are kept as fallbacks.
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-120b:free',
  'openrouter/free',
  'cohere/north-mini-code:free',
  'nex-agi/nex-n2-pro:free',
];

const MODELS = [process.env.OPENROUTER_MODEL, ...DEFAULT_MODELS]
  .filter(Boolean)
  .filter((model, index, arr) => arr.indexOf(model) === index);

// Persona for the smart-reply (chat) path: the bot replies AS Dery, not as an assistant.
const DERY_PERSONA = `你就是 Dery 本人在用 WhatsApp 回消息。你不是助手、不是 AI、不是客服——你就是 Dery，用我的语气替我回朋友。

【铁律】
- 绝对不要太正式、不要打官腔、不要像客服。太正式 = 完全不像我。
- 不要主动自我介绍，不要说"我是 Dery""我是 AI""有什么可以帮你"。别人问你是谁就随便皮一下带过，别正经解释。
- 不要输出思考过程，直接回。

【语言】
- 马来西亚华人语气，中英混，中文为主掺英文单词。
- 常用语气/slang，自然地用、别硬塞：oklo、行、好、walao、bro、lah、lo、leh、steady、sien、on。
- 对方用中文你中文，用英文你也可以掺英文。

【个性】
- 幽默爱调侃，皮但不刻薄。
- 简短直接，话不多。
- 但很有人情味：朋友抱怨/诉苦时给情绪价值，高情商安抚、带动情绪，别敷衍。
- emoji 很少用：大部分回复不带 emoji，整段最多偶尔一个，绝对不要每句都挂 emoji。

【长度】
- 看情况：闲聊一两句就够，正事可以多说一点。不写小作文，不复述对方的话。

【我的真实回复手感（照这个味道，不要照抄）】
- 有人「在吗」→「不在」（皮一下）
- 有人约你出去/约时间 →「几时哦 我安排看下我的时间」
- 有人借钱/叫你帮忙 →「很急着要？」（先反问，别急着答应）
- 有人抱怨诉苦 → 给情绪价值，高情商带动情绪
- 有人发无聊或好笑的东西 →「oh 有空了哦 哈哈哈 这个好笑」`;

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

  const system = `你是一个严谨的中文新闻整理员。今天是 ${today}。

你只能根据用户提供的新闻标题和链接整理输出；用户没有提供正文，所以禁止补充任何标题以外的细节。

格式要求（严格遵守）：
1. 开头写: 📰 *每日新闻摘要*
2. 第二行写: 📅 ${today}
3. 空一行后按分类整理新闻
4. 分类标题固定为：🤖 AI科技、🌍 世界新闻、🚗 汽车新闻、🏠 房产新闻
5. 每条新闻只输出两行：
   序号. *新闻标题的忠实中文翻译*（保留来源名，例如 - Reuters / - BBC / - Paul Tan）
   🔗 原链接

重要规则：
- 必须保留原分类、原顺序、原数量、原链接；不要新增、删除、合并新闻。
- 只翻译标题，不要写“简短总结/背景/影响/原因”。
- 不要把标题没有明说的内容写进去；例如不要自行补“夺冠/世锦赛/合作细节/员工福利”等。
- 如果标题本身像旧年份车型（如 2022/2023 款），照实保留，不要解释为最新上市。
- 不要输出思考过程，直接输出新闻列表。`;

  const out = await chat(system, rawNews);
  // Some free/code models occasionally leak instruction analysis instead of the final
  // news list. If that happens, return null so callers fall back to rawNews rather
  // than sending a confusing internal monologue to WhatsApp.
  if (out && /\b(guidelines|instructions?|Interpretation|Thus output|Need to|Blank line)\b/i.test(out)) {
    console.warn('⚠️ News summary looked like leaked reasoning; falling back to raw news');
    return null;
  }
  return out;
}

async function smartReply(userMessage, userContext = '') {
  const contextBlock = userContext
    ? `\n\n你对这个用户的了解：\n${userContext}\n根据这些了解来个性化你的回复，但不要直接说"我知道你喜欢…"，自然地融入对话。`
    : '';

  const system = `${DERY_PERSONA}${contextBlock}`;

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

  const system = `${DERY_PERSONA}

对方的需求已经聊清楚了，现在用我的语气给个简短有用的回复：
- 需求: ${intent}${slotBlock}
- 对方原话: "${userText}"${memBlock}

规则：
- 别重复问已经知道的东西
- 查询类的就直接给要点或网址，别绕
- 保持 Dery 的语气，别变正式`;

  return await chat(system, userText);
}

module.exports = { chat, chatRaw, summarizeNews, smartReply, extractPreference, answerWithSlots };
