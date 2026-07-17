const express = require('express');
const fs = require('fs');
const path = require('path');

const SITES_DIR = '/home/chin/websites/active';
const META_FILE = '/home/chin/websites/meta.json';
const PORT = 8080;

const app = express();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.get('/', (req, res) => {
  let meta = [];
  try {
    if (fs.existsSync(META_FILE)) meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {}

  const items = meta
    .map(
      (s) => {
        const slug = String(s.slug ?? '');
        const href = `/${encodeURIComponent(slug)}/`;
        const createdAt = new Date(s.createdAt).toLocaleString();
        return `<li><a href="${escapeHtml(href)}">${escapeHtml(slug)}</a> — <em>${escapeHtml(s.description)}</em> <small>(${escapeHtml(createdAt)})</small></li>`;
      }
    )
    .join('\n');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WSB Websites</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px}li{margin:8px 0}</style>
</head><body>
<h1>🌐 WSB Generated Websites</h1>
${items ? `<ul>${items}</ul>` : '<p>No active sites yet.</p>'}
</body></html>`);
});

app.use(express.static(SITES_DIR, { index: 'index.html', extensions: ['html'] }));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Website server listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { app, escapeHtml };
