const fs = require('fs');
const path = require('path');
const { chatRaw } = require('./ai');

const SITES_ROOT = '/home/chin/websites';
const SITES_DIR = path.join(SITES_ROOT, 'active');
const META_FILE = path.join(SITES_ROOT, 'meta.json');
const MAX_SITES = 2;
const PUBLIC_HOST = process.env.WEBSITE_PUBLIC_HOST || 'http://18.141.191.212:8080';

function ensureDirs() {
  if (!fs.existsSync(SITES_DIR)) fs.mkdirSync(SITES_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, '[]');
}

function readMeta() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function generateSlug(description) {
  const safe = (description || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[\u4e00-\u9fa5]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'site';
  const ts = Date.now().toString(36);
  return `${safe || 'site'}-${ts}`;
}

function extractHtml(raw) {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:html)?\s*\n?([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const docIdx = text.search(/<!DOCTYPE html|<html[\s>]/i);
  if (docIdx > 0) text = text.slice(docIdx);
  if (!/<html[\s>]/i.test(text) && !/<!DOCTYPE/i.test(text)) return null;
  return text;
}

function manageSites() {
  const meta = readMeta();
  meta.sort((a, b) => a.createdAt - b.createdAt);
  while (meta.length >= MAX_SITES) {
    const oldest = meta.shift();
    const dir = path.join(SITES_DIR, oldest.slug);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`🗑️  Removed old site: ${oldest.slug}`);
    } catch (e) {
      console.error(`Failed to remove ${oldest.slug}: ${e.message}`);
    }
  }
  writeMeta(meta);
  return meta;
}

async function buildWebsite(description, sender) {
  ensureDirs();
  if (!description || description.length < 3) {
    return { error: '描述太短，请详细说明你想要的网站' };
  }

  const systemPrompt = `你是一名资深的前端工程师，专门生成单文件 HTML 网站。

严格要求：
1. 输出一个完整的单文件 HTML 页面，包含 <!DOCTYPE html>、<html>、<head>、<body>
2. 所有 CSS 和 JavaScript 都内嵌在 HTML 中（<style> 和 <script> 标签）
3. 不要使用外部依赖文件（除非是从 CDN 加载的 JS 库）
4. 移动端友好（添加 viewport meta tag），界面美观现代
5. 如需实时数据，使用免费公开 API（如 open-meteo、coingecko、各类公开 REST API）。优先选支持 CORS 的 API
6. 如有定时刷新需求，使用 setInterval 在前端自动刷新
7. 错误处理：API 失败时显示友好提示
8. 直接输出 HTML 代码本身，不要任何 markdown 包裹、不要解释、不要前言后语`;

  const userMessage = `请生成一个网站：${description}`;

  console.log(`🏗️  Building site for: ${description}`);
  const raw = await chatRaw(systemPrompt, userMessage, 6000);
  if (!raw) return { error: 'AI 生成失败，请稍后重试' };

  const html = extractHtml(raw);
  if (!html) {
    console.error('Invalid HTML output:', raw.slice(0, 200));
    return { error: 'AI 返回的内容不是有效 HTML，请重试或换个描述' };
  }

  manageSites();

  const slug = generateSlug(description);
  const siteDir = path.join(SITES_DIR, slug);
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'index.html'), html);

  const meta = readMeta();
  meta.push({
    slug,
    description,
    sender: sender || 'unknown',
    createdAt: Date.now(),
  });
  writeMeta(meta);

  const url = `${PUBLIC_HOST}/${slug}/`;
  console.log(`✅ Site built: ${url}`);
  return { url, slug };
}

function listSites() {
  return readMeta()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}

function deleteSite(slug) {
  const meta = readMeta();
  const idx = meta.findIndex((m) => m.slug === slug);
  if (idx === -1) return { error: `未找到网站: ${slug}` };
  meta.splice(idx, 1);
  writeMeta(meta);
  const dir = path.join(SITES_DIR, slug);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { error: `删除目录失败: ${e.message}` };
  }
  return { ok: true };
}

module.exports = { buildWebsite, listSites, deleteSite, MAX_SITES, PUBLIC_HOST };
