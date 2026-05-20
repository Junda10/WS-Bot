const axios = require('axios');

const OR_API = 'https://openrouter.ai/api/frontend/models/find';

async function fetchTopModels(order = 'top-weekly', limit = 10) {
  try {
    const res = await axios.get(OR_API, {
      params: { order },
      timeout: 15000,
    });
    const models = res.data?.data?.models || [];
    return models
      .filter((m) => m.output_modalities?.includes('text'))
      .slice(0, limit)
      .map((m, i) => ({
        rank: i + 1,
        name: m.short_name || m.name,
        author: m.author_display_name || m.author || '',
        slug: m.slug,
        context: m.context_length,
      }));
  } catch (err) {
    console.error('Leaderboard fetch error:', err.message);
    return [];
  }
}

async function fetchNewModels(limit = 10) {
  try {
    const res = await axios.get(OR_API, {
      params: { order: 'newest' },
      timeout: 15000,
    });
    const models = res.data?.data?.models || [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return models
      .filter((m) => {
        if (!m.output_modalities?.includes('text')) return false;
        const created = new Date(m.created_at);
        return created >= sevenDaysAgo;
      })
      .slice(0, limit)
      .map((m) => ({
        name: m.short_name || m.name,
        author: m.author_display_name || m.author || '',
        slug: m.slug,
        date: m.created_at?.slice(0, 10) || '',
        context: m.context_length,
      }));
  } catch (err) {
    console.error('New models fetch error:', err.message);
    return [];
  }
}

function formatCtx(ctx) {
  if (!ctx) return '';
  if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(0)}M`;
  if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`;
  return String(ctx);
}

function formatLeaderboard(topModels, newModels) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const today = `${yyyy}-${mm}-${dd} 星期${days[now.getDay()]}`;

  let msg = `🏆 *AI模型排行榜*\n📅 *${today}*\n━━━━━━━━━━━━━━━━━━\n\n`;

  if (topModels.length > 0) {
    msg += `🔥 *本周热门 Top 10*\n\n`;
    const medals = ['🥇', '🥈', '🥉'];
    topModels.forEach((m) => {
      const icon = medals[m.rank - 1] || `${m.rank}.`;
      msg += `${icon} *${m.name}*\n`;
      msg += `   ${m.author} · ${formatCtx(m.context)} ctx\n\n`;
    });
  }

  if (newModels.length > 0) {
    msg += `🆕 *本周新模型*\n\n`;
    newModels.forEach((m, i) => {
      msg += `${i + 1}. *${m.name}*\n`;
      msg += `   ${m.author} · ${m.date} · ${formatCtx(m.context)} ctx\n\n`;
    });
  }

  msg += `📊 来源: OpenRouter\n🔗 openrouter.ai/rankings`;
  return msg;
}

async function getLeaderboard() {
  const [topModels, newModels] = await Promise.all([
    fetchTopModels('top-weekly', 10),
    fetchNewModels(10),
  ]);

  if (topModels.length === 0 && newModels.length === 0) {
    return '❌ 暂时无法获取排行榜数据，请稍后再试';
  }

  return formatLeaderboard(topModels, newModels);
}

module.exports = { getLeaderboard, fetchTopModels, fetchNewModels };
