// history.js — 短期对话上下文（滚动窗口）
// 每个会话(chatId)只保留最近 N 条消息（默认 200），超出自动删除最旧的。
// 不做空闲超时清除；改用「会话数上限 + 淘汰最久未活动会话」按数量兜底，纯内存不会堆满。
// 用途：让聊天回复能接住上文（群里谁说了啥、bot 刚发过啥）。

const MAX = parseInt(process.env.CONTEXT_MAX_MESSAGES || '200', 10);
const MAX_CHATS = parseInt(process.env.CONTEXT_MAX_CHATS || '200', 10);

const store = new Map(); // chatId -> { msgs: [{role, name, text, ts}], last }

function _get(chatId) {
  let e = store.get(chatId);
  if (!e) {
    e = { msgs: [], last: Date.now() };
    store.set(chatId, e);
  }
  return e;
}

function _push(chatId, role, text, name) {
  if (!chatId || !text || !text.trim()) return;
  const e = _get(chatId);
  e.msgs.push({ role, name: name || '', text: text.trim().slice(0, 1000), ts: Date.now() });
  // 超出上限自动删除最旧的（保留最近 MAX 条）
  if (e.msgs.length > MAX) e.msgs.splice(0, e.msgs.length - MAX);
  e.last = Date.now();
  // 会话数超上限时，淘汰最久未活动的会话，防止 Map 无限增长
  if (store.size > MAX_CHATS) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of store) { if (v.last < oldest) { oldest = v.last; oldestKey = k; } }
    if (oldestKey && oldestKey !== chatId) store.delete(oldestKey);
  }
}

function appendUser(chatId, name, text) { _push(chatId, 'user', text, name); }
function appendAssistant(chatId, text) { _push(chatId, 'assistant', text); }

// 返回给 LLM 用的消息数组 [{role, content}]，群里给 user 消息带上发言人名字。
function getMessages(chatId) {
  const e = store.get(chatId);
  if (!e) return [];
  return e.msgs.map((m) => ({
    role: m.role,
    content: m.role === 'user' && m.name ? `${m.name}: ${m.text}` : m.text,
  }));
}

function clear(chatId) { store.delete(chatId); }

module.exports = { appendUser, appendAssistant, getMessages, clear, MAX };
