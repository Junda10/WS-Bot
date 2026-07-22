require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const axios = require('axios');
const config = require('./config');
const { getDatabase, closeDatabase } = require('./db/connection');
const { migrateDatabase } = require('./db/migrate');

try {
  config.assertValid();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

let database;
try {
  database = getDatabase({
    filename: config.database.path,
    busyTimeoutMs: config.database.busyTimeoutMs,
  });
  const migrationResult = migrateDatabase(database);
  console.log(`🗄️ SQLite ready (schema version ${migrationResult.currentVersion})`);
} catch (error) {
  closeDatabase(database);
  console.error(`❌ Startup database migration failed: ${error.message}`);
  process.exit(1);
}

const { fetchNews, formatNewsMessage, getAllNews } = require('./news-fetcher');
const { summarizeNews, smartReply, extractPreference, answerWithSlots, chat } = require('./ai');
const { addFact, trackTopic, getTopTopics, getFactsSummary, clearMemory } = require('./memory');
const { getReply, setReply } = require('./cache');
const { classifyIntent, generateOptions } = require('./intent');
const { getSession, setSession, clearSession, pruneExpired } = require('./session');
const { getLeaderboard } = require('./leaderboard');
const { buildWebsite, listSites, deleteSite, MAX_SITES, PUBLIC_HOST } = require('./website-builder');
const autoreply = require('./autoreply');
const workout = require('./workout');
const fx = require('./fx');
const history = require('./history');
const { createMessageDeduper } = require('./message-deduper');

// Admin who approves auto-replying to new numbers. Set AUTOREPLY_ADMIN in .env
// (full international number, e.g. 60XXXXXXXXX; a leading-0 local MY number is
// auto-converted to +60). NEVER hardcode a real number here — this repo is public.
// If unset, the per-number gate is disabled and everyone is auto-replied as before.
function _toIntlMY(raw) {
  let n = autoreply.normalize(raw);
  if (n.startsWith('0')) n = '60' + n.slice(1);
  return n;
}
const ADMIN_NUMBER = _toIntlMY(process.env.AUTOREPLY_ADMIN || '');
const ADMIN_ID = ADMIN_NUMBER ? `${ADMIN_NUMBER}@c.us` : '';

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
// Users whose reply is currently being generated/sent (incl. the human-typing pause).
// Serializes replies per user so the multi-second humanPause can't overlap and race
// on the shared chat typing state or interleave out-of-order replies.
const replyInFlight = new Set();
// whatsapp-web.js can redeliver the same event after reconnect/reinjection.
// Deduplicate by the stable WhatsApp message ID before any command or reply runs.
const isDuplicateMessage = createMessageDeduper();

console.log('🤖 WhatsApp AI新闻机器人启动中...');
console.log(`🧠 AI模型: ${process.env.OPENROUTER_MODEL || 'not set'}`);

client.on('qr', (qr) => {
  console.log('\n📱 请用手机WhatsApp扫描以下二维码:');
  qrcode.generate(qr, { small: true });
});

let schedulesRegistered = false;
client.on('ready', () => {
  console.log('✅ 机器人已连接!');

  if (schedulesRegistered) {
    console.log('ℹ️ 定时任务已注册，跳过重复 ready 初始化');
    return;
  }
  schedulesRegistered = true;

  const min = String(config.scheduleMinute);
  const hr = String(config.scheduleHour);
  // Interpret the schedule in scheduleTz (default MY time), not the server's UTC clock.
  cron.schedule(`${min} ${hr} * * *`, () => sendMorningNews(), { timezone: config.scheduleTz });
  console.log(`⏰ 每天 ${config.scheduleHour}:${String(config.scheduleMinute).padStart(2, '0')} (${config.scheduleTz}) 自动发送AI新闻摘要`);

  // 每日健身教练提醒（默认中午 12:00 大马时间，把当天训练/休息计划发给自己）。
  if (config.fitness?.enabled) {
    const fMin = String(config.fitness.minute);
    const fHr = String(config.fitness.hour);
    cron.schedule(`${fMin} ${fHr} * * *`, () => sendFitnessReminder(), { timezone: config.scheduleTz });
    console.log(`🏋️ 每天 ${config.fitness.hour}:${String(config.fitness.minute).padStart(2, '0')} (${config.scheduleTz}) 自动发送健身提醒`);
  }

  // 每日汇率推送（默认晚上 20:00 大马时间发到群组）。
  if (config.fx?.enabled) {
    const xMin = String(config.fx.minute);
    const xHr = String(config.fx.hour);
    cron.schedule(`${xMin} ${xHr} * * *`, () => sendFxUpdate(), { timezone: config.scheduleTz });
    console.log(`💱 每天 ${config.fx.hour}:${String(config.fx.minute).padStart(2, '0')} (${config.scheduleTz}) 自动发送汇率推送`);
  }

  // setTimeout(() => {
  //   console.log('📰 首次启动，发送测试新闻...');
  //   sendMorningNews();
  // }, 10000);
});

client.on('authenticated', () => console.log('🔐 认证成功'));
client.on('auth_failure', (msg) => console.error('❌ 认证失败:', msg));

let reinitTimer = null;
let reinitInProgress = false;
client.on('disconnected', (reason) => {
  console.log('🔌 断开连接:', reason);
  // Debounce + guard: avoid a tight re-initialize loop on repeated disconnects.
  if (reinitInProgress) return;
  if (reinitTimer) clearTimeout(reinitTimer);
  reinitTimer = setTimeout(async () => {
    reinitInProgress = true;
    try {
      console.log('♻️ 5秒后重新初始化客户端...');
      // Tear down the old Puppeteer page before initialize(). Reusing an injected
      // page can accumulate whatsapp-web.js event listeners and duplicate messages.
      try { await client.destroy(); } catch (destroyErr) {
        console.warn('旧客户端清理失败，继续重新初始化:', destroyErr.message);
      }
      await client.initialize();
    } catch (err) {
      console.error('重新初始化失败:', err.message);
    } finally {
      reinitInProgress = false;
    }
  }, 5000);
});

const CATEGORY_LOADING = {
  tech: '⏳ 🧠 AI正在获取AI科技新闻...',
  world: '⏳ 🧠 AI正在获取世界新闻...',
  car: '⏳ 🧠 AI正在获取汽车新闻...',
  property: '⏳ 🧠 AI正在获取房产新闻...',
};

// Parse '10m' / '2h' / '30s' / '1d' into seconds (cap 7 days). Returns null if unparseable.
function parseDuration(text) {
  const m = /^\s*(\d+)\s*([smhd])\s*$/i.exec(text || '');
  if (!m) return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = parseInt(m[1], 10) * units[m[2].toLowerCase()];
  return seconds > 0 && seconds <= 7 * 86400 ? seconds : null;
}

// Notify the admin that a new number messaged, so they can approve/deny auto-reply.
async function notifyAdminNewNumber(number, name, preview) {
  const snippet = (preview || '').slice(0, 200);
  const text =
    `📩 *新号码来信*\n` +
    `号码: ${number}\n` +
    `名称: ${name || '(未知)'}\n` +
    `内容: ${snippet}\n\n` +
    `是否自动回复这个人？\n` +
    `✅ 开启: !ar on ${number}\n` +
    `🚫 关闭: !ar off ${number}\n` +
    `📋 查看名单: !ar list`;
  try {
    await client.sendMessage(ADMIN_ID, text);
  } catch (err) {
    console.error('notifyAdminNewNumber failed:', err.message);
  }
}

// Fetch, format, AI-summarize, and reply with one news category.
// Shared by the !tech / !world / !car / !property commands.
async function sendCategoryNews(message, category) {
  await message.reply(CATEGORY_LOADING[category] || '⏳ 获取新闻中...');
  const items = await fetchNews(category);
  const raw = formatNewsMessage(category, items);
  const summary = await summarizeNews(raw);
  await message.reply(summary || raw);
}

client.on('message', async (message) => {
  const messageId = message.id?._serialized;
  if (messageId && isDuplicateMessage(messageId)) {
    console.warn(`⚠️ 忽略重复消息事件: ${messageId}`);
    return;
  }

  const body = message.body.trim();
  const cmd = body.toLowerCase();

  // 记录进对话上下文（命令、空消息、bot 自己发的不记）。用轻量的 notifyName，避免每条都 getContact。
  if (!message.fromMe && body && !body.startsWith('!')) {
    const name = message._data?.notifyName || (message.author || '').split('@')[0] || '';
    history.appendUser(message.from, name, body);
  }

  if (cmd.startsWith('!')) {
    try {
      // !website <description> — generate website (prefix match, preserve original casing for description)
      if (cmd.startsWith('!website ') || cmd === '!website') {
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

      // ── Interactive commands ──────────────────────────────────────────────
      // !ask <question> — direct AI answer
      if (cmd.startsWith('!ask ')) {
        const q = body.slice(4).trim();
        if (!q) { await message.reply('用法: !ask <问题>'); return; }
        await message.reply('🤔 思考中...');
        const ans = await chat('你是一个有帮助的助手，用简洁中文回答用户问题。直接给答案，不要前言，不要思考过程。', q);
        await message.reply(ans || '😅 暂时答不上来，等下再试');
        return;
      }
      // !translate <text> — auto CN<->EN
      if (cmd.startsWith('!translate ') || cmd.startsWith('!tr ')) {
        const text = body.replace(/^!(translate|tr)\s+/i, '').trim();
        if (!text) { await message.reply('用法: !translate <要翻译的内容>'); return; }
        const sys = 'You are a translator. If the input is Chinese, translate to natural English; otherwise translate to natural Chinese. Output ONLY the translation, no quotes, no explanation.';
        const out = await chat(sys, text);
        await message.reply(out || '翻译失败，等下再试');
        return;
      }
      // !weather <city> — current weather via wttr.in (no API key)
      if (cmd.startsWith('!weather ') || cmd.startsWith('!天气 ')) {
        const city = body.replace(/^!(weather|天气)\s+/i, '').trim();
        if (!city) { await message.reply('用法: !weather <城市>'); return; }
        try {
          const res = await axios.get(
            `https://wttr.in/${encodeURIComponent(city)}?format=%l:+%c+%t+(体感+%f)+💨%w&m&lang=zh`,
            { timeout: 15000, headers: { 'User-Agent': 'curl' } }
          );
          await message.reply(`🌤️ ${String(res.data).trim()}`);
        } catch (err) {
          await message.reply('☁️ 查不到这个城市的天气，换个名字试试');
        }
        return;
      }
      // !健身 / !fitness — 健身教练：今日计划 / 整周计划 / 某天详情
      if (cmd === '!健身' || cmd === '!fitness' || cmd === '!workout' || cmd === '!gym'
          || cmd.startsWith('!健身 ') || cmd.startsWith('!fitness ') || cmd.startsWith('!workout ') || cmd.startsWith('!gym ')) {
        const arg = body.replace(/^!(健身|fitness|workout|gym)\s*/i, '').trim().toLowerCase();
        if (arg === '周' || arg === 'week' || arg === 'w') {
          await message.reply(workout.weekMessage());
        } else if (['a', 'b', 'c'].includes(arg)) {
          await message.reply(workout.formatWorkout(arg.toUpperCase()));
        } else {
          await message.reply(workout.todayMessage(config.scheduleTz));
        }
        return;
      }
      // !汇率 / !fx — live 汇率 + 7天高低 + 兑换建议 + AI走势
      if (cmd === '!汇率' || cmd === '!fx' || cmd === '!rate' || cmd === '!fx ai' || cmd === '!汇率 ai') {
        await message.reply('💱 获取实时汇率中...');
        const withAI = cmd.endsWith(' ai') || config.fx?.ai !== false;
        const text = await fx.buildMessage({ withAI });
        await message.reply(text);
        return;
      }
      // !remind <dur> <msg> — ping back after a delay
      if (cmd.startsWith('!remind ')) {
        const rest = body.slice(8).trim();
        const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
        const seconds = m ? parseDuration(m[1]) : null;
        if (!m || !seconds) { await message.reply('用法: !remind 10m 内容（支持 s/m/h/d，最长 7 天）'); return; }
        const what = m[2];
        await message.reply(`⏰ 好，${m[1]} 后提醒你：${what}`);
        setTimeout(() => { message.reply(`⏰ 提醒时间到：${what}`).catch(() => {}); }, seconds * 1000);
        return;
      }
      // !broadcast <msg> — whitelist-gated send to configured groups
      if (cmd.startsWith('!broadcast ')) {
        const senderId = message.author || message.from;
        if (!config.websiteWhitelist || !config.websiteWhitelist.includes(senderId)) {
          await message.reply('⛔ 你没有权限使用此功能');
          return;
        }
        const text = body.slice('!broadcast'.length).trim();
        if (!text) { await message.reply('用法: !broadcast <消息>'); return; }
        const groups = (process.env.BROADCAST_GROUPS || config.groupId || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        if (!groups.length) { await message.reply('没有配置广播群组（设置 BROADCAST_GROUPS 或 GROUP_ID）'); return; }
        let ok = 0;
        for (const g of groups) {
          try { await client.sendMessage(g, text); ok++; } catch (e) { console.error('broadcast fail', g, e.message); }
        }
        await message.reply(`📢 已广播到 ${ok}/${groups.length} 个群组`);
        return;
      }
      // !ar — manage the per-number auto-reply list (admin number only)
      if (cmd === '!ar' || cmd.startsWith('!ar ')) {
        const senderNum = autoreply.normalize(message.author || message.from);
        // Require a configured admin AND an exact match (guards the ADMIN_NUMBER='' + senderNum='' bypass).
        if (!ADMIN_NUMBER || senderNum !== ADMIN_NUMBER) { await message.reply('⛔ 仅管理员可用'); return; }
        const args = body.slice(3).trim().split(/\s+/).filter(Boolean);
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'on' || sub === 'off') {
          const target = autoreply.normalize(args[1]);
          if (!target) { await message.reply(`用法: !ar ${sub} <号码>`); return; }
          autoreply.setStatus(target, sub);
          await message.reply(`${sub === 'on' ? '✅ 已开启' : '🚫 已关闭'} ${target} 的自动回复`);
          return;
        }
        if (sub === 'list' || sub === 'pending') {
          const all = autoreply.listAll();
          const entries = Object.entries(all).filter(([, v]) => sub === 'list' || v.status === 'pending');
          if (!entries.length) { await message.reply(sub === 'pending' ? '没有待审批的号码' : '名单是空的 🐟'); return; }
          const lines = entries.map(([num, v]) => {
            const icon = v.status === 'on' ? '✅' : v.status === 'off' ? '🚫' : '⏳';
            return `${icon} ${num}${v.name ? ` (${v.name})` : ''} — ${v.status}`;
          });
          await message.reply(`📋 *自动回复名单 (${entries.length})*\n━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}`);
          return;
        }
        await message.reply('用法:\n*!ar on <号码>* — 开启自动回复\n*!ar off <号码>* — 关闭\n*!ar list* — 查看全部名单\n*!ar pending* — 查看待审批');
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
        case '!tech':
        case '!world':
        case '!car':
        case '!property': {
          await sendCategoryNews(message, cmd.slice(1));
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
            `🤖 *AI新闻机器人命令*\n━━━━━━━━━━━━━━━━━━\n\n*!news* - 📰 AI总结所有新闻\n*!tech* - 🤖 AI科技新闻\n*!world* - 🌍 世界新闻\n*!car* - 🚗 汽车新闻\n*!property* - 🏠 房产新闻\n*!rank* - 🏆 AI模型排行榜\n*!raw* - 📋 原始新闻\n\n*!ask <问题>* - 🤔 问 AI\n*!translate <内容>* - 🌐 中英互译\n*!weather <城市>* - 🌤️ 查天气\n*!remind <时长> <内容>* - ⏰ 定时提醒 (如 10m)\n*!健身* - 🏋️ 今日健身计划 (周/A/B/C 查详情)\n*!汇率* - 💱 美元/新币兑马币 live 汇率 + 兑换建议\n\n*!mymemory* - 🧠 查看小W对你的了解\n*!forget* - 🗑️ 清除所有记忆\n*!nosession* - 🗑️ 清除当前多轮对话状态\n*!groups* - 📋 列出所有群组ID\n*!website <描述>* - 🌐 生成网站 (白名单)\n*!websites* - 📋 查看活跃网站\n*!delsite <slug>* - 🗑️ 删除网站 (白名单)\n*!broadcast <消息>* - 📢 广播到群组 (白名单)\n*!ar* - 🔐 管理自动回复名单 (管理员)\n*!help* - ❓ 帮助菜单\n\n💡 发送任何消息，小W会智能回复（并记住你的偏好）\n━━━━━━━━━━━━━━━━━━`
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

    // Per-number auto-reply gate (individual chats only; groups, admin & owner exempt).
    // Disabled entirely when no admin is configured (AUTOREPLY_ADMIN unset).
    if (ADMIN_NUMBER && message.from.endsWith('@c.us')) {
      const number = autoreply.normalize(message.from);
      const isAdmin = number === ADMIN_NUMBER;
      const isOwner = config.myNumber && number === autoreply.normalize(config.myNumber);
      if (!isAdmin && !isOwner) {
        const status = autoreply.getStatus(number);
        if (status === null) {
          // Brand-new number: claim the slot synchronously FIRST (markPending is atomic
          // and returns true only once), so a near-simultaneous 2nd message from the same
          // number can't double-notify the admin during the getContact() await below.
          const isNew = autoreply.markPending(number, '');
          if (isNew) {
            let name = '';
            try { const c = await message.getContact(); name = c.pushname || c.name || ''; } catch {}
            if (name) autoreply.setStatus(number, 'pending', name);
            await notifyAdminNewNumber(number, name, body);
          }
          return; // stay silent until approved
        }
        if (status !== 'on') return; // 'off' or 'pending' -> do not auto-reply
        // 'on' -> fall through to the smart-reply path
      }
    }

    if (body.length <= 1) return;

    const debounceMs = config.smartReply?.debounceMs ?? 3000;
    const entry = smartReplyBuffers.get(userId) || { messages: [], lastMessage: null, timer: null };
    entry.messages.push(body);
    entry.lastMessage = message;
    if (entry.timer) clearTimeout(entry.timer);
    const fire = () => {
      // A reply for this user is still being sent (humanPause in progress) — wait and
      // retry instead of launching a concurrent flow that would race the typing state.
      if (replyInFlight.has(userId)) {
        entry.timer = setTimeout(fire, 1500);
        return;
      }
      smartReplyBuffers.delete(userId);
      const merged = entry.messages.join('\n');
      replyInFlight.add(userId);
      processSmartReply(entry.lastMessage, merged, userId)
        .catch(err => console.error('Smart-reply (debounced) error:', err.message))
        .finally(() => replyInFlight.delete(userId));
    };
    entry.timer = setTimeout(fire, debounceMs);
    smartReplyBuffers.set(userId, entry);
    if (entry.messages.length > 1) {
      console.log(`[DEBOUNCE user=${userId} buffered=${entry.messages.length} waiting=${debounceMs}ms]`);
    }
  }
});

// Anti-ban human pause: pace the reply like a human typing. The target delay scales
// with the reply length (base thinking time + per-char typing time), is jittered, and
// clamped to [min, max]. `startedAt` anchors it to when processing began, so AI
// generation time already counts toward the target (no double-waiting).
function _typingDelayMs(text) {
  const s = config.smartReply || {};
  const base = s.replyDelayBaseMs ?? 1000;
  const perChar = s.replyDelayPerCharMs ?? 80;
  const min = s.replyDelayMinMs ?? 2000;
  const max = s.replyDelayMaxMs ?? 5000;
  const raw = base + (text ? text.length : 0) * perChar;
  const jitter = 0.85 + Math.random() * 0.3; // ±15% so it's not metronomic
  return Math.min(max, Math.max(min, Math.round(raw * jitter)));
}

async function humanPause(chat, startedAt, replyText) {
  const wait = _typingDelayMs(replyText) - (Date.now() - startedAt);
  if (wait > 0) {
    try { await chat.sendStateTyping(); } catch {}
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function processSmartReply(message, body, userId) {
    const startedAt = Date.now();
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

      const chatId = message.from;
      // Cache by both conversation and sender: replies can contain user facts and chat history.
      const cacheScope = `${chatId}:${userId}`;
      // 换汇/汇率问题：汇率随时在变，绕过回复缓存，保证每次都是最新数字。
      const isFxQ = fx.isFxQuestion(body);
      const cached = isFxQ ? null : getReply(body, cacheScope);
      if (cached) {
        // Was an instant reply (ban risk) — pace it like a human typing.
        await humanPause(chat, startedAt, cached);
        await chat.clearState();
        await message.reply(cached);
        history.appendAssistant(chatId, cached);
      } else {
        await chat.sendStateTyping();

        const facts = getFactsSummary(userId);
        const topTopics = getTopTopics(userId);
        let context = '';
        if (facts) context += `记录的偏好：\n${facts}`;
        if (topTopics.length) context += `\n常聊话题：${topTopics.join(', ')}`;

        // 换汇/汇率类问题 → 注入实时汇率上下文，让回复基于真实数字（聊天仍走 OpenRouter）。
        if (isFxQ) {
          const fxCtx = await fx.contextSummary();
          if (fxCtx) context += `\n\n${fxCtx}`;
        }

        // 带上最近对话上下文（末尾即当前消息，含群里发言人 & bot 刚发的内容）。
        const convo = history.getMessages(chatId);
        const aiReply = await smartReply(body, context, convo);
        if (aiReply) {
          if (!isFxQ) setReply(body, aiReply, cacheScope); // 汇率答复不缓存（数字会过期）
          // Pad to the human delay (AI gen time already counts toward it), typing shown.
          await humanPause(chat, startedAt, aiReply);
          await chat.clearState();
          await message.reply(aiReply);
          history.appendAssistant(chatId, aiReply);
        } else {
          await chat.clearState();
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
      history.appendAssistant(chatId, `（我刚在群里发了今日AI新闻摘要）\n${summary || ''}`);
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

// 每日健身提醒：把当天训练/休息计划发给自己（或 FITNESS_TARGET）。
async function sendFitnessReminder() {
  const target = config.fitness?.target
    || (config.myNumber ? config.myNumber.replace(/[^0-9]/g, '') + '@c.us' : '');
  if (!target) {
    console.error('❌ 健身提醒无接收方：请设置 MY_NUMBER 或 FITNESS_TARGET');
    return;
  }
  try {
    const text = workout.todayMessage(config.scheduleTz);
    await client.sendMessage(target, text);
    history.appendAssistant(target, text);
    console.log('✅ 健身提醒发送成功!');
  } catch (err) {
    console.error(`❌ 健身提醒发送失败: ${err.message}`);
  }
}

// 每日汇率推送：live USD→MYR / SGD→MYR + 7天高低 + 兑换建议 + AI走势，默认发到群组。
async function sendFxUpdate() {
  const target = config.fx?.target
    || config.groupId
    || (config.myNumber ? config.myNumber.replace(/[^0-9]/g, '') + '@c.us' : '');
  if (!target) {
    console.error('❌ 汇率推送无接收方：请设置 GROUP_ID / MY_NUMBER 或 FX_TARGET');
    return;
  }
  try {
    console.log('💱 获取汇率中...');
    const text = await fx.buildMessage({ withAI: config.fx?.ai !== false });
    await client.sendMessage(target, text);
    // 记入上下文，这样群友追问「现在换划算吗」时 bot 知道刚发过汇率。
    history.appendAssistant(target, text);
    console.log('✅ 汇率推送发送成功!');
  } catch (err) {
    console.error(`❌ 汇率推送发送失败: ${err.message}`);
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} received, shutting down...`);

  if (reinitTimer) {
    clearTimeout(reinitTimer);
    reinitTimer = null;
  }

  // Close the synchronous database first so it is never left open while the
  // asynchronous WhatsApp/Puppeteer teardown is waiting.
  closeDatabase(database);
  try {
    await client.destroy();
  } catch (error) {
    console.warn(`WhatsApp client shutdown failed: ${error.message}`);
  }
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('exit', () => closeDatabase(database));

// Database migration above must succeed before WhatsApp can initialize or emit ready.
client.initialize().catch((error) => {
  console.error(`WhatsApp initialization failed: ${error.message}`);
  closeDatabase(database);
  process.exitCode = 1;
});
