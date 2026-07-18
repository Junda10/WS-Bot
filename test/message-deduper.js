const assert = require('assert');
const { createMessageDeduper } = require('../message-deduper');

let time = 1000;
const dedupe = createMessageDeduper({ ttlMs: 100, maxEntries: 2, now: () => time });

assert.strictEqual(dedupe('msg-1'), false, 'first delivery must run');
assert.strictEqual(dedupe('msg-1'), true, 'same message ID must be ignored');
assert.strictEqual(dedupe('msg-2'), false, 'different messages must run');
assert.strictEqual(dedupe('msg-3'), false, 'new messages must run at capacity');
assert.strictEqual(dedupe('msg-1'), false, 'oldest ID must be evicted at capacity');

time += 101;
assert.strictEqual(dedupe('msg-3'), false, 'an ID may run again after the TTL');
assert.strictEqual(dedupe(''), false, 'missing IDs cannot be deduplicated');

console.log('Message deduper checks OK');
