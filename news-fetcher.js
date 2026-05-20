const axios = require('axios');

const RSS_FEEDS = {
  tech: [
    {
      name: 'Google News - LLM Global',
      url: 'https://news.google.com/rss/search?q=ChatGPT+OR+Gemini+OR+Grok+OR+Claude+OR+LLM+OR+DeepSeek+OR+Llama+when:1d&hl=en',
    },
    {
      name: 'Google News - AI Companies',
      url: 'https://news.google.com/rss/search?q=OpenAI+OR+Anthropic+OR+xAI+OR+Mistral+OR+Qwen+OR+Meta+AI+OR+Midjourney+OR+Stable+Diffusion+when:1d&hl=en',
    },
    {
      name: 'Google News - AI中文',
      url: 'https://news.google.com/rss/search?q=AI模型+OR+大语言模型+OR+人工智能+OR+DeepSeek+OR+文心一言+when:1d&hl=zh-CN',
    },
  ],
  car: [
    {
      name: 'Google News - 马来西亚汽车',
      url: 'https://news.google.com/rss/search?q=Malaysia+car+Proton+Perodua+when:1d&hl=zh-CN&gl=MY&ceid=MY:zh-Hans',
    },
    {
      name: 'Google News - 大马车市',
      url: 'https://news.google.com/rss/search?q=马来西亚+汽车+新闻+when:1d&hl=zh-CN&gl=MY&ceid=MY:zh-Hans',
    },
  ],
  world: [
    {
      name: 'Google News - 世界新闻',
      url: 'https://news.google.com/rss/search?q=world+news+when:1d&hl=zh-CN&gl=MY&ceid=MY:zh-Hans',
    },
    {
      name: 'Google News - 国际要闻',
      url: 'https://news.google.com/rss/search?q=国际+要闻+when:1d&hl=zh-CN&gl=MY&ceid=MY:zh-Hans',
    },
  ],
  property: [
    {
      name: 'Google News - 马来西亚房产',
      url: 'https://news.google.com/rss/search?q=Malaysia+property+real+estate+when:1d&hl=zh-CN&gl=MY&ceid=MY:zh-Hans',
    },
    {
      name: 'Google News - 大马房产',
      url: 'https://news.google.com/rss/search?q=马来西亚+房产+房地产+when:1d&hl=zh-CN&gl=MY&ceid=MY:zh-Hans',
    },
  ],
};

function parseRSSItems(xmlText, maxItems = 5) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null && items.length < maxItems) {
    const itemXml = match[1];
    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const pubDate = extractTag(itemXml, 'pubDate');

    if (title) {
      items.push({
        title: cleanHtml(title),
        link: link || '',
        date: pubDate ? formatDate(pubDate) : '',
        rawDate: pubDate || '',
      });
    }
  }

  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  if (match) return match[1] || match[2] || '';
  return '';
}

function cleanHtml(text) {
  return text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

async function shortenUrl(longUrl) {
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`, { timeout: 5000 });
    return res.data;
  } catch {
    return longUrl;
  }
}

async function fetchNewsFromFeed(feed) {
  try {
    const response = await axios.get(feed.url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });
    return parseRSSItems(response.data, 5);
  } catch (err) {
    console.error(`Failed to fetch from ${feed.name}: ${err.message}`);
    return [];
  }
}

async function fetchNews(category) {
  const feeds = RSS_FEEDS[category];
  if (!feeds) return [];

  const allItems = [];
  for (const feed of feeds) {
    const items = await fetchNewsFromFeed(feed);
    allItems.push(...items);
  }

  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const seen = new Set();
  const unique = allItems.filter((item) => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    if (item.rawDate && new Date(item.rawDate) < twoDaysAgo) return false;
    return true;
  }).slice(0, 5);

  await Promise.all(unique.map(async (item) => {
    if (item.link) {
      item.link = await shortenUrl(item.link);
    }
  }));

  return unique;
}

function getTodayString() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const dayName = days[now.getDay()];
  return `${yyyy}-${mm}-${dd} 星期${dayName}`;
}

function formatNewsMessage(category, items) {
  const categoryNames = {
    tech: '🤖 *AI科技新闻*',
    world: '🌍 *世界新闻*',
    car: '🚗 *汽车新闻*',
    property: '🏠 *房产新闻*',
  };

  const header = categoryNames[category] || '📰 *新闻*';

  if (!items || items.length === 0) {
    return `${header}\n暂无最新新闻\n`;
  }

  let message = `${header}\n\n`;

  items.forEach((item, index) => {
    message += `${index + 1}. *${item.title}*\n`;
    message += `   🔗 ${item.link}\n\n`;
  });

  return message;
}

async function getAllNews() {
  const categories = ['tech', 'world', 'car', 'property'];
  const today = getTodayString();
  let fullMessage = `📰 *每日新闻汇总*\n📅 *${today}*\n━━━━━━━━━━━━━━━━━━\n\n`;

  for (const cat of categories) {
    const items = await fetchNews(cat);
    fullMessage += formatNewsMessage(cat, items) + '\n';
  }

  return fullMessage.trim();
}

module.exports = { fetchNews, formatNewsMessage, getAllNews };
