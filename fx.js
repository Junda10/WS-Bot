// fx.js — 每日汇率推送模块（增强版）
// 提供 USD→MYR、SGD→MYR 的 live 汇率（Yahoo Finance 实时外汇，24/5 交易），
// 附带近 7 天高低区间、是否为 7 天最高的判断、兑换方向参考，以及可选的 AI 走势分析。
//
// 数据源：
//   主：Yahoo Finance chart（query1.finance.yahoo.com）—— live 报价 + 7 天日线历史，免费无 key
//   备：open.er-api（每日更新一次）—— 主源失败时兜底
// 无隐私信息（本仓库公开）。moomoo 换汇价无公开 API，暂不接入。

const axios = require('axios');
const { chat } = require('./ai');

const YH = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = { 'User-Agent': 'Mozilla/5.0' };

// 取单个货币对的 live 报价。symbol 例：'USDMYR'、'SGDMYR'。
async function yahooLive(symbol) {
  const { data } = await axios.get(`${YH}${symbol}=X?interval=1d&range=1d`, { headers: UA, timeout: 12000 });
  const m = data.chart.result[0].meta;
  return {
    price: m.regularMarketPrice,
    prevClose: m.previousClose ?? m.chartPreviousClose ?? null,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
  };
}

// 取近 7 天日线收盘（跳过空值/周末）。返回 [{date, close}]。
async function yahoo7d(symbol) {
  const { data } = await axios.get(`${YH}${symbol}=X?interval=1d&range=7d`, { headers: UA, timeout: 12000 });
  const r = data.chart.result[0];
  const ts = r.timestamp || [];
  const close = (r.indicators && r.indicators.quote && r.indicators.quote[0].close) || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (close[i] != null) out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: close[i] });
  }
  return out;
}

// open.er-api 兜底（每日一次）。返回与 yahoo 一致的最小结构。
async function erApiFallback() {
  const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 12000 });
  const usdmyr = data.rates.MYR;
  const sgdmyr = data.rates.MYR / data.rates.SGD; // 每 1 新币换多少马币
  return { usdmyr, sgdmyr };
}

// 组合一个货币对的完整数据：live 价 + 7 天高低 + 今天是否最高。
async function pairStats(symbol) {
  const [live, hist] = await Promise.all([yahooLive(symbol), yahoo7d(symbol)]);
  // 用“历史收盘（不含最新一天，避免重复）+ 当前 live 价”组成 7 天参照集。
  const priorCloses = hist.slice(-7).map((h) => h.close);
  const all = [...priorCloses, live.price].filter((v) => typeof v === 'number');
  const high = Math.max(...all);
  const low = Math.min(...all);
  const isHigh = live.price >= high - 1e-9;
  const isLow = live.price <= low + 1e-9;
  const range = high - low;
  const position = range > 1e-9 ? (live.price - low) / range : 0.5; // 0=最低 1=最高
  const change = live.prevClose ? live.price - live.prevClose : null;
  const changePct = live.prevClose ? (change / live.prevClose) * 100 : null;
  return { symbol, ...live, high, low, isHigh, isLow, position, change, changePct, hist };
}

function arrow(change) {
  if (change == null) return '';
  if (change > 0) return '▲';
  if (change < 0) return '▼';
  return '=';
}

function fmtChange(s) {
  if (s.change == null) return '';
  const a = arrow(s.change);
  return ` ${a} ${s.change >= 0 ? '+' : ''}${s.change.toFixed(4)} (${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%)`;
}

// 让 AI 分析近 7 天走势并给兑换时机看法（失败则返回空串，不影响主消息）。
// 简化：所有 AI 文案统一走 OpenRouter GLM，不再额外调用本机 Claude CLI。
async function aiAnalysis(usd, sgd) {
  const series = usd.hist.slice(-7).map((h) => `${h.date}:${h.close.toFixed(4)}`).join(', ');
  const sys = '你是简洁专业的外汇分析助手。只用中文，2-3 句话，不要免责声明，不要 markdown 标题。';
  const task = `${sys}\n\n`
    + `美元兑马币(USD/MYR)近7天收盘: ${series}。当前 live: ${usd.price.toFixed(4)}（7天高 ${usd.high.toFixed(4)}, 低 ${usd.low.toFixed(4)}）。`
    + `新币兑马币(SGD/MYR) 当前 ${sgd.price.toFixed(4)}。`
    + `请判断美元兑马币的短期走势（走强/走弱/震荡），并给出：现在换马币(卖美元)划不划算、换美元(买美元/美股)划不划算的一句话建议。`;

  try {
    const out = await chat(sys, task);
    return (out || '').trim();
  } catch (e) {
    console.error('fx OpenRouter GLM 分析失败:', e.message);
    return '';
  }
}

// 生成每日汇率推送文案。withAI=true 时附带 AI 走势分析。
async function buildMessage({ withAI = true } = {}) {
  let usd, sgd;
  try {
    [usd, sgd] = await Promise.all([pairStats('USDMYR'), pairStats('SGDMYR')]);
  } catch (e) {
    // Yahoo 失败 → 兜底（无高低/走势，仅报当前价）
    console.error('Yahoo 汇率获取失败，改用兜底源:', e.message);
    const f = await erApiFallback();
    return `💱 *今日汇率*（兜底源，每日更新）\n━━━━━━━━━━━━━━━━━━\n\n`
      + `🇺🇸 美元 → 马币: *${f.usdmyr.toFixed(4)}*\n`
      + `🇸🇬 新币 → 马币: *${f.sgdmyr.toFixed(4)}*\n\n`
      + `⚠️ 实时源暂时不可用，以上为参考中间价。`;
  }

  const t = usd.time ? new Date(usd.time) : null;
  const tzTime = t ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false }).format(t) : '';
  const dateStr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Kuala_Lumpur', month: '2-digit', day: '2-digit' }).format(t || new Date());

  const pos = Math.round(usd.position * 100);
  let verdict;
  if (usd.isHigh) verdict = '📈 *今天是近 7 天最高！* 手上有美元的话，现在换马币最划算。';
  else if (usd.isLow) verdict = '📉 *今天是近 7 天最低。* 要买美元(投美股)现在最划算；卖美元换马币建议再等等。';
  else verdict = `📊 今天*不是* 7 天最高（处于 7 天区间的 ${pos}% 位置）。`;

  let out = `💱 *今日汇率* · ${dateStr}${tzTime ? ` (${tzTime} live)` : ''}\n━━━━━━━━━━━━━━━━━━\n\n`;
  out += `🇺🇸 *美元 → 马币*  \`${usd.price.toFixed(4)}\`${fmtChange(usd)}\n`;
  out += `🇸🇬 *新币 → 马币*  \`${sgd.price.toFixed(4)}\`${fmtChange(sgd)}\n\n`;
  out += `📅 近 7 天 USD/MYR：高 \`${usd.high.toFixed(4)}\` · 低 \`${usd.low.toFixed(4)}\`\n\n`;
  out += `${verdict}\n\n`;
  out += `💡 *兑换参考*\n`;
  out += `• 换马币(卖美元)：越高越划算 —— 现在 ${pos >= 66 ? '偏高 ✅' : pos <= 33 ? '偏低 ⏳' : '中位'}\n`;
  out += `• 换美元(买美股)：越低越划算 —— 现在 ${pos <= 33 ? '偏低 ✅' : pos >= 66 ? '偏高 ⏳' : '中位'}\n`;

  if (withAI) {
    const a = await aiAnalysis(usd, sgd);
    if (a) out += `\n🤖 *走势分析*\n${a}\n`;
  }

  out += `\n_数据源: Yahoo Finance live · 仅供参考，非投资建议_`;
  return out;
}

// 判断一条聊天消息是否在问换汇/汇率（关键词启发式，快速无 LLM）。
// 需同时命中「货币词」+「动作/汇率词」，降低误判。
function isFxQuestion(text) {
  const t = (text || '').toLowerCase();
  const cur = /(美元|马币|令吉|新币|新加坡币|美金|usd|myr|sgd|ringgit|dollar)/.test(t);
  const act = /(换|兑|汇率|rate|exchange|convert|买|卖|划算|值不值|涨|跌|多少钱)/.test(t);
  return cur && act;
}

// 生成一段紧凑的实时汇率事实上下文，注入到聊天系统提示里（不调 AI，保证回复快）。
// 失败返回空串，不影响正常聊天。
async function contextSummary() {
  try {
    const [usd, sgd] = await Promise.all([pairStats('USDMYR'), pairStats('SGDMYR')]);
    const pos = Math.round(usd.position * 100);
    // 按 7 天区间位置判断（比精确取最值更稳，靠近高/低点也能给出方向）。
    let stance;
    if (pos >= 85) stance = `美元接近近7天高点(区间${pos}%)：卖美元换马币此刻较划算，买美元偏贵`;
    else if (pos <= 15) stance = `美元接近近7天低点(区间${pos}%)：买美元/投美股此刻较划算，卖美元换马币不划算`;
    else stance = `美元处7天区间${pos}%位置：无明显优势，看需求而定`;
    return `[实时汇率参考·仅供参考非投资建议]\n`
      + `美元→马币 ${usd.price.toFixed(4)}（近7天 ${usd.low.toFixed(4)}~${usd.high.toFixed(4)}）；`
      + `新币→马币 ${sgd.price.toFixed(4)}。判断：${stance}。\n`
      + `若用户在问换汇/汇率/要不要换，请用上面的真实数字自然地回答并给出简短建议（换多少可以反问），别只说"去银行换"。`;
  } catch (e) {
    console.error('fx contextSummary 失败:', e.message);
    return '';
  }
}

module.exports = { buildMessage, pairStats, yahooLive, yahoo7d, isFxQuestion, contextSummary };
