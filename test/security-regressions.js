'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { escapeHtml } = require('../website-server');

test('website output continues to escape active HTML/XSS payloads', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('xss')"> & text`),
    '&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; text'
  );
});

test('reply cache remains scoped and ignores unscoped legacy records', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-cache-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '..', 'cache.js'), path.join(tempDir, 'cache.js'));
  const cache = require(path.join(tempDir, 'cache.js'));

  cache.setReply('What should I do?', 'private reply for A', 'chat-a:user-a');
  assert.equal(cache.getReply('What should I do?', 'chat-a:user-a'), 'private reply for A');
  assert.equal(cache.getReply('What should I do?', 'chat-a:user-b'), null);
  assert.equal(cache.getReply('What should I do?', 'chat-b:user-a'), null);

  // Approximate matching must work within one scope but never cross its boundary.
  assert.equal(cache.getReply('What should I do now?', 'chat-a:user-a'), 'private reply for A');
  assert.equal(cache.getReply('What should I do now?', 'chat-a:user-b'), null);

  // Pre-fix cache records have no scope and must not satisfy a scoped lookup.
  fs.writeFileSync(
    path.join(tempDir, 'reply-cache.json'),
    JSON.stringify({ 'legacy question': { reply: 'legacy private reply', time: Date.now(), hits: 0 } })
  );
  assert.equal(cache.getReply('legacy question', 'chat-a:user-a'), null);
});
