const axios = require('axios');

const OR_API = 'https://openrouter.ai/api/v1/models';
const SEVEN_DAYS = 7 * 24 * 60 * 60;

async function fetchAllModels() {
  const res = await axios.get(OR_API, { timeout: 15000 });
  const models = res.data?.data || [];
  return models.filter((m) => m.architecture?.output_modalities?.includes('text'));
}

function isFree(m) {
  const p = m.pricing || {};
  return p.prompt === '0' && p.completion === '0';
}

function supportsReasoning(m) {
  const sp = m.supported_parameters || [];
  return sp.includes('reasoning') || sp.includes('include_reasoning');
}

function formatCtx(ctx) {
  if (!ctx) return '';
  if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
  return String(ctx);
}

function modelName(m) {
  return m.name || m.id;
}

function modelAuthor(m) {
  const id = m.id || '';
  return id.split('/')[0] || '';
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toISOString().slice(0, 10);
}

function todayHeader() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  return `${yyyy}-${mm}-${dd} 星期${days[now.getDay()]}`;
}

function sectionNewModels(models, limit = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS;
  const items = models
    .filter((m) => m.created && m.created >= cutoff)
    .sort((a, b) => b.created - a.created)
    .slice(0, limit);
  if (!items.length) return '';
  let s = `🆕 *本周新模型 (7天内)*\n\n`;
  items.forEach((m, i) => {
    s += `${i + 1}. *${modelName(m)}*\n`;
    s += `   ${modelAuthor(m)} · ${formatDate(m.created)} · ${formatCtx(m.context_length)} ctx\n\n`;
  });
  return s;
}

function sectionNewFreeModels(models, limit = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS;
  const items = models
    .filter((m) => isFree(m) && m.created && m.created >= cutoff)
    .sort((a, b) => b.created - a.created)
    .slice(0, limit);
  if (!items.length) return '';
  let s = `🆓 *本周新免费模型*\n\n`;
  items.forEach((m, i) => {
    s += `${i + 1}. *${modelName(m)}*\n`;
    s += `   ${modelAuthor(m)} · ${formatDate(m.created)} · ${formatCtx(m.context_length)} ctx\n\n`;
  });
  return s;
}

function sectionBigContext(models, limit = 10) {
  const items = [...models]
    .filter((m) => m.context_length)
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .slice(0, limit);
  if (!items.length) return '';
  let s = `📊 *最大 Context Top ${limit}*\n\n`;
  const medals = ['🥇', '🥈', '🥉'];
  items.forEach((m, i) => {
    const icon = medals[i] || `${i + 1}.`;
    s += `${icon} *${modelName(m)}*\n`;
    s += `   ${modelAuthor(m)} · ${formatCtx(m.context_length)} ctx\n\n`;
  });
  return s;
}

function sectionReasoningModels(models, limit = 7) {
  const items = models
    .filter(supportsReasoning)
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, limit);
  if (!items.length) return '';
  let s = `🧠 *最新支持推理 (Thinking) 的模型*\n\n`;
  items.forEach((m, i) => {
    s += `${i + 1}. *${modelName(m)}*\n`;
    s += `   ${modelAuthor(m)} · ${formatDate(m.created)} · ${formatCtx(m.context_length)} ctx\n\n`;
  });
  return s;
}

async function getLeaderboard() {
  let models;
  try {
    models = await fetchAllModels();
  } catch (err) {
    console.error('Leaderboard fetch error:', err.message);
    return '❌ 暂时无法获取排行榜数据，请稍后再试';
  }
  if (!models.length) return '❌ 暂时无法获取排行榜数据，请稍后再试';

  const sections = [
    sectionNewModels(models),
    sectionNewFreeModels(models),
    sectionBigContext(models),
    sectionReasoningModels(models),
  ].filter(Boolean);

  if (!sections.length) return '❌ 暂时无法获取排行榜数据，请稍后再试';

  const header = `🏆 *AI模型排行榜*\n📅 *${todayHeader()}*\n━━━━━━━━━━━━━━━━━━\n\n`;
  const footer = `📊 来源: OpenRouter\n🔗 openrouter.ai/models`;
  return header + sections.join('') + footer;
}

module.exports = { getLeaderboard };
