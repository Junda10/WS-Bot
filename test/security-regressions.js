const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { escapeHtml } = require('../website-server');

assert.strictEqual(
  escapeHtml(`<img src=x onerror="alert('xss')"> & text`),
  '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; text'
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-cache-test-'));
try {
  fs.copyFileSync(path.join(__dirname, '..', 'cache.js'), path.join(tempDir, 'cache.js'));
  const cache = require(path.join(tempDir, 'cache.js'));

  cache.setReply('What should I do?', 'private reply for A', 'chat-a:user-a');
  assert.strictEqual(cache.getReply('What should I do?', 'chat-a:user-a'), 'private reply for A');
  assert.strictEqual(cache.getReply('What should I do?', 'chat-a:user-b'), null);
  assert.strictEqual(cache.getReply('What should I do?', 'chat-b:user-a'), null);

  // Approximate matching must work within one scope but never cross its boundary.
  assert.strictEqual(cache.getReply('What should I do now?', 'chat-a:user-a'), 'private reply for A');
  assert.strictEqual(cache.getReply('What should I do now?', 'chat-a:user-b'), null);

  // Pre-fix cache records have no scope and must not satisfy a scoped lookup.
  fs.writeFileSync(
    path.join(tempDir, 'reply-cache.json'),
    JSON.stringify({ 'legacy question': { reply: 'legacy private reply', time: Date.now(), hits: 0 } })
  );
  assert.strictEqual(cache.getReply('legacy question', 'chat-a:user-a'), null);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('Security regression checks OK');
