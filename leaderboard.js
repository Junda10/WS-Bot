const axios = require('axios');

const AA_MODELS_URL = 'https://artificialanalysis.ai/models';

async function fetchArtificialAnalysisData() {
  const res = await axios.get(AA_MODELS_URL, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WSBot/1.0)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const html = String(res.data || '');
  const scripts = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];

  const latestReleases = extractLatestReleases(html);
  let bestDataset = [];
  for (const script of scripts) {
    const jsonText = script
      .replace(/^<script type="application\/ld\+json">/, '')
      .replace(/<\/script>$/, '');
    try {
      const data = JSON.parse(jsonText);
      const isIntelligenceDataset =
        data?.['@type'] === 'Dataset' &&
        typeof data.name === 'string' &&
        data.name.includes('Intelligence') &&
        Array.isArray(data.data);
      if (!isIntelligenceDataset) continue;

      const items = data.data
        .map((item) => ({
          ...item,
          intelligenceIndex: item.intelligenceIndex ?? item.artificialAnalysisIntelligenceIndex,
        }))
        .filter((item) => item.label && Number.isFinite(item.intelligenceIndex))
        .sort((a, b) => b.intelligenceIndex - a.intelligenceIndex);

      if (items.length > bestDataset.length) bestDataset = items;
    } catch (_) {
      // Keep scanning; Artificial Analysis embeds several JSON-LD datasets.
    }
  }

  if (bestDataset.length) return { intelligence: bestDataset, latestReleases };
  throw new Error('Artificial Analysis intelligence dataset not found');
}

function lastRegexMatch(text, regex) {
  let last = null;
  for (const match of text.matchAll(regex)) last = match;
  return last;
}

function firstRegexMatch(text, regex) {
  const match = text.match(regex);
  return match || null;
}

function extractLatestReleases(html) {
  const releaseRegex = /\\"release_date\\":\\"(\d{4}-\d{2}-\d{2})\\"/g;
  const releasesBySlug = new Map();

  for (const releaseMatch of html.matchAll(releaseRegex)) {
    const date = releaseMatch[1];
    const before = html.slice(Math.max(0, releaseMatch.index - 60000), releaseMatch.index);
    const after = html.slice(releaseMatch.index, releaseMatch.index + 3000);

    const nameMatch = lastRegexMatch(before, /\\"name\\":\\"([^\\"]+)\\"/g);
    const shortNameMatch = firstRegexMatch(after, /\\"short_name\\":\\"([^\\"]+)\\"/);
    const slugMatch = firstRegexMatch(after, /\\"slug\\":\\"([^\\"]+)\\"/);
    const creatorMatch = firstRegexMatch(after, /\\"model_creators\\":\{[\s\S]*?\\"name\\":\\"([^\\"]+)\\"/);

    const rawName = nameMatch?.[1];
    const slug = slugMatch?.[1];
    if (!rawName || !slug) continue;
    if (['Artificial Analysis', 'Intelligence', 'Speed', 'Cost per Task'].includes(rawName)) continue;

    releasesBySlug.set(slug, {
      date,
      label: shortNameMatch?.[1] || rawName,
      creator: creatorMatch?.[1] || '',
      detailsUrl: `/models/${slug}`,
    });
  }

  return [...releasesBySlug.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function formatScore(score) {
  return Number(score).toFixed(1).replace(/\.0$/, '');
}

function todayHeader() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  return `${yyyy}-${mm}-${dd} 星期${days[now.getDay()]}`;
}

function sectionLatestReleases(models, limit = 5) {
  const items = models.slice(0, limit);
  if (!items.length) return '';

  let s = `🆕 *Latest Release Models Top ${limit}*\n`;
  s += `_按 Artificial Analysis 记录的 release date 排序_\n\n`;

  items.forEach((m, i) => {
    const url = m.detailsUrl ? `https://artificialanalysis.ai${m.detailsUrl}` : '';
    s += `${i + 1}. *${m.label}*\n`;
    s += `   ${m.creator ? `${m.creator} · ` : ''}${m.date}`;
    if (url) s += ` · ${url}`;
    s += `\n\n`;
  });
  return s;
}

function sectionTopIntelligence(models, limit = 10) {
  const items = models.slice(0, limit);
  const medals = ['🥇', '🥈', '🥉'];
  let s = `🧠 *Artificial Analysis Intelligence Index Top ${limit}*\n`;
  s += `_综合智能榜，分数越高越强；不是按 Context 或 Thinking 参数排序_\n\n`;

  items.forEach((m, i) => {
    const icon = medals[i] || `${i + 1}.`;
    const url = m.detailsUrl ? `https://artificialanalysis.ai${m.detailsUrl}` : '';
    s += `${icon} *${m.label}*\n`;
    s += `   Intelligence: ${formatScore(m.intelligenceIndex)}`;
    if (url) s += ` · ${url}`;
    s += `\n\n`;
  });
  return s;
}

async function getLeaderboard() {
  let data;
  try {
    data = await fetchArtificialAnalysisData();
  } catch (err) {
    console.error('Leaderboard fetch error:', err.message);
    return '❌ 暂时无法获取 Artificial Analysis 排行榜数据，请稍后再试';
  }
  if (!data.intelligence.length) return '❌ 暂时无法获取 Artificial Analysis 排行榜数据，请稍后再试';

  const header = `🏆 *AI Top Models 排行榜*\n📅 *${todayHeader()}*\n━━━━━━━━━━━━━━━━━━\n\n`;
  const footer = `📊 来源: Artificial Analysis\n🔗 artificialanalysis.ai/models`;
  return header + sectionLatestReleases(data.latestReleases) + sectionTopIntelligence(data.intelligence) + footer;
}

module.exports = { getLeaderboard };
