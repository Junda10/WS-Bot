'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMessageDeduper } = require('../message-deduper');

test('message deduper preserves TTL, capacity eviction, and missing-ID regressions', () => {
  let time = 1000;
  const dedupe = createMessageDeduper({ ttlMs: 100, maxEntries: 2, now: () => time });

  assert.equal(dedupe('msg-1'), false, 'first delivery must run');
  assert.equal(dedupe('msg-1'), true, 'same message ID must be ignored');
  assert.equal(dedupe('msg-2'), false, 'different messages must run');
  assert.equal(dedupe('msg-3'), false, 'new messages must run at capacity');
  assert.equal(dedupe('msg-1'), false, 'oldest ID must be evicted at capacity');

  time += 101;
  assert.equal(dedupe('msg-3'), false, 'an ID may run again after the TTL');
  assert.equal(dedupe(''), false, 'missing IDs cannot be deduplicated');
});
