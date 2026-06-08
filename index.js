require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const config = require('./config');
const { fetchNews, formatNewsMessage, getAllNews } = require('./news-fetcher');
const { summarizeNews, smartReply, extractPreference, answerWithSlots } = require('./ai');
const { addFact, trackTopic, getTopTopics, getFactsSummary, clearMemory } = require('./memory');
const { getReply, setReply } = require('./cache');
const { classifyIntent, generateOptions } = require('./intent');
const { getSession, setSession, clearSession, pruneExpired } = require('./session');
const { getLeaderboard } = require('./leaderboard');
const { buildWebsite, listSites, deleteSite, MAX_SITES, PUBLIC_HOST } = require('./website-builder');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

const autoReplyTracker = new Map();
const COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Per-user smart-reply debounce buffer.
// Map<userId, { messages: string[], lastMessage, timer }>
const smartReplyBuffers = new Map();

console.log('🤖 WhatsApp AI新闻机器人启动中...');
console.log(`🧠 AI模型: ${process.env.OPENROUTER_MODEL || 'not set'}`);

client.on('qr', (qr) => {
  console.log('\n📱 请用手机WhatsApp扫描以下二维码:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ 机器人已连接!');

  const min = String(config.scheduleMinute);
  const hr = String(config.scheduleHour);
  cron.schedule(`${min} ${hr} * * *`, () => sendMorningNews());
  console.log(`⏰ 每天 ${config.scheduleHour}:${String(config.scheduleMinute).padStart(2, '0')} 自动发送AI新闻摘要`);

  // setTimeout(() => {
  //   console.log('📰 首次启动，发送测试新闻...');
  //   sendMorningNews();
  // }, 10000);
});

client.on('authenticated', () => console.log('🔐 认证成功'));
client.on('auth_failure', (msg) => console.error('❌ 认证失败:', msg));

client.on('disconnected', (reason) => {
  console.log('🔌 断开连接:', reason);
  client.initialize();
});

client.on('message', async (message) => {
  const body = message.body.trim();
  const cmd = body.toLowerCase();

  if (cmd.startsWith('!')) {
    try {
      // !website <description> — generate website (prefix match, preserve original casing for description)
      if (cmd.startsWith('!website ') || cmd === '!website') {
        const config = require('./config');
        const senderId = message.author || message.from;
        if (!config.websiteWhitelist || !config.websiteWhitelist.includes(senderId)) {
          await message.reply('⛔ 你没有权限使用此功能');
          return;
        }
        const description = body.slice('!website'.length).trim();
        if (!description) {
          await message.reply('用法: !website <描述>\n例如: !website 实时飞机票价格网站');
          return;
        }
        await message.reply('⏳ 正在生成网站，可能需要 30-60 秒...');
        const result = await buildWebsite(description, senderId);
        if (result.error) {
          await message.reply('❌ ' + result.error);
        } else {
          await message.reply(`✅ 网站已生成！\n🔗 ${result.url}\n\n📌 最多保留 ${MAX_SITES} 个网站，旧的会被自动清除`);
        }
        return;
      }
      if (cmd === '!websites') {
        const sites = listSites();
        if (!sites.length) {
          await message.reply('📋 当前没有活跃的网站');
        } else {
          const lines = sites.map((s, i) =>
            `${i + 1}. ${s.slug}\n   📝 ${s.description}\n   🔗 ${PUBLIC_HOST}/${s.slug}/\n   🕐 ${new Date(s.createdAt).toLocaleString()}`
          ).join('\n\n');
          await message.reply(`📋 *活跃网站 (${sites.length}/${MAX_SITES})*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`);
        }
        return;
      }
      if (cmd.startsWith('!delsite ')) {
        const config = require('./config');
        const senderId = message.author || message.from;
        if (!config.websiteWhitelist || !config.websiteWhitelist.includes(senderId)) {
          await message.reply('⛔ 你没有权限使用此功能');
          return;
        }
        const slug = body.slice('!delsite'.length).trim();
        if (!slug) {
          await message.reply('用法: !delsite <slug>');
          return;
        }
        const result = deleteSite(slug);
        if (result.error) await message.reply('❌ ' + result.error);
        else await message.reply(`🗑️ 已删除网站: ${slug}`);
        return;
      }
      switch (cmd) {
        case '!news': {
          await message.reply('⏳ 🧠 AI正在获取并总结所有新闻...');
          const rawNews = await getAllNews();
          const summary = await summarizeNews(rawNews);
          await message.reply(summary || rawNews);
          return;
        }
        case '!tech': {
          await message.reply('⏳ 🧠 AI正在获取AI科技新闻...');
          const items = await fetchNews('tech');
          const raw = formatNewsMessage('tech', items);
          const summary = await summarizeNews(raw);
          await message.reply(summary || raw);
          return;
        }
        case '!world': {
          await message.reply('⏳ 🧠 AI正在获取世界新闻...');
          const wItems = await fetchNews('world');
          const wRaw = formatNewsMessage('world', wItems);
          const wSummary = await summarizeNews(wRaw);
          await message.reply(wSummary || wRaw);
          return;
        }
        case '!car': {
          await message.reply('⏳ 🧠 AI正在获取汽车新闻...');
          const items = await fetchNews('car');
          const raw = formatNewsMessage('car', items);
          const summary = await summarizeNews(raw);
          await message.reply(summary || raw);
          return;
        }
        case '!property': {
          await message.reply('⏳ 🧠 AI正在获取房产新闻...');
          const items = await fetchNews('property');
          const raw = formatNewsMessage('property', items);
          const summary = await summarizeNews(raw);
          await message.reply(summary || raw);
          return;
        }
        case '!rank': {
          await message.reply('⏳ 🏆 获取AI模型排行榜...');
          const board = await getLeaderboard();
          await message.reply(board);
          return;
        }
        case '!raw': {
          await message.reply('⏳ 获取原始新闻中...');
          const news = await getAllNews();
          await message.reply(news);
          return;
        }
        case '!mymemory': {
          const memUserId = message.author || message.from;
          const memFacts = getFactsSummary(memUserId);
          const memTopics = getTopTopics(memUserId, 5);
          let memMsg = `🧠 *小W对你的了解*\n━━━━━━━━━━━━━━━━━━\n`;
          if (memFacts) memMsg += `\n📝 *记住的事情:*\n${memFacts}`;
          else memMsg += `\n还不了解你，多聊聊吧！`;
          if (memTopics.length) memMsg += `\n\n📊 *你常聊的话题:* ${memTopics.join(', ')}`;
          await message.reply(memMsg);
          return;
        }
        case '!forget': {
          const forgetUserId = message.author || message.from;
          clearMemory(forgetUserId);
          await message.reply('🗑️ 已清除所有关于你的记忆，重新开始！');
          return;
        }
        case '!nosession': {
          const sUserId = message.author || message.from;
          clearSession(sUserId);
          await message.reply('🗑️ 已清除当前多轮对话状态');
          return;
        }
        case '!groups': {
          const chats = await client.getChats();
          const groups = chats.filter(c => c.isGroup);
          const list = groups.map((g, i) => `${i + 1}. *${g.name}*\n   ID: ${g.id._serialized}`).join('\n\n');
          await message.reply(`📋 *你的群组列表*\n━━━━━━━━━━━━━━━━━━\n\n${list}\n\n共 ${groups.length} 个群组`);
          return;
        }
        case '!help': {
          await message.reply(
            `🤖 *AI新闻机器人命令*\n━━━━━━━━━━━━━━━━━━\n\n*!news* - 📰 AI总结所有新闻\n*!tech* - 🤖 AI科技新闻\n*!world* - 🌍 世界新闻\n*!car* - 🚗 汽车新闻\n*!property* - 🏠 房产新闻\n*!rank* - 🏆 AI模型排行榜\n*!raw* - 📋 原始新闻\n*!mymemory* - 🧠 查看小W对你的了解\n*!forget* - 🗑️ 清除所有记忆\n*!nosession* - 🗑️ 清除当前多轮对话状态\n*!groups* - 📋 列出所有群组ID\n*!website <描述>* - 🌐 生成网站 (白名单)\n*!websites* - 📋 查看活跃网站\n*!delsite <slug>* - 🗑️ 删除网站 (白名单)\n*!help* - ❓ 帮助菜单\n\n💡 发送任何消息，小W会智能回复（并记住你的偏好）\n━━━━━━━━━━━━━━━━━━`
          );
          return;
        }
      }
    } catch (err) {
      console.error('Command error:', err.message);
    }
    return;
  }

  if (!message.fromMe && body.length > 0) {
    const userId = message.author || message.from;

    // The core requirement for this bot is an immediate "ok" auto-reply.
    // Keep the newer AI smart-reply path available only when AUTO_REPLY_ENABLED=false.
    if (config.autoReply?.enabled) {
      await message.reply(config.autoReply.message || 'ok');
      return;
    }

    if (body.length <= 1) return;

    const debounceMs = config.smartReply?.debounceMs ?? 15000;
    const entry = smartReplyBuffers.get(userId) || { messages: [], lastMessage: null, timer: null };
    entry.messages.push(body);
    entry.lastMessage = message;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      smartReplyBuffers.delete(userId);
      const merged = entry.messages.join('\n');
      processSmartReply(entry.lastMessage, merged, userId).catch(err => {
        console.error('Smart-reply (debounced) error:', err.message);
      });
    }, debounceMs);
    smartReplyBuffers.set(userId, entry);
    if (entry.messages.length > 1) {
      console.log(`[DEBOUNCE user=${userId} buffered=${entry.messages.length} waiting=${debounceMs}ms]`);
    }
  }
});

async function processSmartReply(message, body, userId) {
    try {
      const chat = await message.getChat();
      const clar = config.clarification || {};
      const clarifyOn = clar.enabled && (!clar.whitelist?.length || clar.whitelist.includes(userId));

      if (clarifyOn) {
        try {
          await chat.sendStateTyping();
          const handled = await handleClarification(message, chat, body, userId);
          await chat.clearState();
          if (handled) {
            extractPreference(body).then(pref => {
              if (!pref) return;
              if (pref.topic && pref.topic !== 'other') trackTopic(userId, pref.topic);
              if (pref.fact) addFact(userId, pref.fact);
            }).catch(() => {});
            return;
          }
          // handled=false → fall through to legacy smartReply
        } catch (clarErr) {
          console.error('Clarification error, falling back:', clarErr.message);
          await chat.clearState().catch(() => {});
        }
      }

      const cached = getReply(body);
      if (cached) {
        await message.reply(cached);
      } else {
        await chat.sendStateTyping();

        const facts = getFactsSummary(userId);
        const topTopics = getTopTopics(userId);
        let context = '';
        if (facts) context += `记录的偏好：\n${facts}`;
        if (topTopics.length) context += `\n常聊话题：${topTopics.join(', ')}`;

        const aiReply = await smartReply(body, context);
        await chat.clearState();
        if (aiReply) {
          setReply(body, aiReply);
          await message.reply(aiReply);
        }
      }

      extractPreference(body).then(pref => {
        if (!pref) return;
        if (pref.topic && pref.topic !== 'other') trackTopic(userId, pref.topic);
        if (pref.fact) addFact(userId, pref.fact);
      }).catch(() => {});
    } catch (err) {
      console.error('Smart-reply error:', err.message);
    }
}

const CANCEL_RE = /^\s*(算了|取消|不用了|cancel|stop|退出)\s*[。\.!！]*\s*$/i;

async function handleClarification(message, chat, body, userId) {
  pruneExpired();
  const clar = config.clarification;

  if (CANCEL_RE.test(body)) {
    const had = !!getSession(userId);
    clearSession(userId);
    if (had) {
      await message.reply('好的，已取消当前询问 ✅');
      return true;
    }
    return false;
  }

  const session = getSession(userId);

  // Resolve user input against last options if a session is active
  let resolvedAnswer = body;
  let pendingSlot = null;
  if (session && session.lastOptions && Array.isArray(session.lastOptions)) {
    pendingSlot = session.missing?.[0] || null;
    const num = parseInt(body.trim(), 10);
    if (Number.isFinite(num) && num >= 1 && num <= session.lastOptions.length) {
      const chosen = session.lastOptions[num - 1];
      // Last option is the freeform escape hatch — keep raw text
      if (num === session.lastOptions.length && /其他/.test(chosen)) {
        // user picked freeform but didn't supply text; ask for it
        await message.reply('请直接说明你的需求：');
        return true;
      }
      resolvedAnswer = chosen;
    }
  }

  // Build the text used for classification
  const classifyText = session
    ? `原始需求已明确为 intent=${session.intent}。用户刚才回答了、针对问题「${session.lastQuestion || ''}」、答案是「${resolvedAnswer}」。请重新评估。`
    : body;

  let classification;
  try {
    classification = await classifyIntent(classifyText, session);
  } catch (err) {
    console.error('classifyIntent failed:', err.message);
    return false; // fall back to smartReply
  }

  // Merge resolved slot value into slots_filled if user just answered a pending slot
  if (session && pendingSlot && resolvedAnswer && !classification.slots_filled[pendingSlot]) {
    classification.slots_filled[pendingSlot] = resolvedAnswer;
  }
  // Carry over any previously-filled slots
  if (session) {
    classification.slots_filled = { ...(session.slots || {}), ...classification.slots_filled };
  }

  const ambiguity = 1 - classification.confidence;
  const rounds = (session?.rounds || 0) + 1;
  const threshold = clar.ambiguityThreshold ?? 0.1;
  const hitCap = rounds >= (clar.maxRounds || 20);

  console.log(`[CLARIFY user=${userId} round=${rounds} intent=${classification.intent} amb=${Math.round(ambiguity * 100)}% ready=${classification.ready_to_answer}]`);
  if (rounds === (clar.softWarnRound || 10)) {
    console.warn(`[CLARIFY soft-warn] user=${userId} reached round ${rounds} without convergence`);
  }

  // Decide: answer or ask another question?
  const shouldAnswer = classification.ready_to_answer || ambiguity <= threshold || hitCap || classification.slots_missing.length === 0;

  if (shouldAnswer) {
    const memContext = [getFactsSummary(userId), (getTopTopics(userId) || []).join(', ')].filter(Boolean).join('\n');
    let reply;
    try {
      reply = await answerWithSlots(classification.intent, classification.slots_filled, body, memContext);
    } catch (err) {
      console.error('answerWithSlots failed:', err.message);
      reply = null;
    }
    if (!reply) reply = await smartReply(body, memContext).catch(() => null);
    if (reply) {
      if (hitCap) reply = reply + '\n\n(提示：信息可能不完整，如需重新开始请发 !nosession)';
      await message.reply(reply);
    }
    clearSession(userId);
    return true;
  }

  // Otherwise: ask the next clarifying question
  const missingSlot = classification.slots_missing[0];
  let qa;
  try {
    qa = await generateOptions(classification.intent, missingSlot, classification.slots_filled);
  } catch (err) {
    console.error('generateOptions failed:', err.message);
    return false; // fall back to smartReply
  }

  const numbered = qa.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const text = `${qa.question}\n${numbered}\n\n（回复数字或直接描述）`;

  setSession(userId, {
    intent: classification.intent,
    slots: classification.slots_filled,
    missing: classification.slots_missing,
    lastQuestion: qa.question,
    lastOptions: qa.options,
    rounds,
    startedAt: session?.startedAt || Date.now(),
  });

  await message.reply(text);
  return true;
}

async function sendMorningNews() {
  if (!config.myNumber) {
    console.error('❌ 请在 config.js 填入手机号码');
    return;
  }

  const chatId = config.groupId || (config.myNumber.replace(/[^0-9]/g, '') + '@c.us');
  console.log('📰 获取新闻中...');

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const rawNews = await getAllNews();
      console.log('🧠 AI总结新闻中...');
      const summary = await summarizeNews(rawNews);
      await client.sendMessage(chatId, summary || rawNews);
      console.log('✅ AI新闻摘要发送成功!');

      console.log('🏆 获取模型排行榜...');
      const board = await getLeaderboard();
      await client.sendMessage(chatId, board);
      console.log('✅ 模型排行榜发送成功!');
      return;
    } catch (err) {
      console.error(`❌ 第${attempt}次发送失败: ${err.message}`);
      if (attempt < maxRetries) {
        console.log(`⏳ ${attempt * 5}秒后重试...`);
        await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
  }
  console.error('❌ 新闻发送最终失败');
}

client.initialize();
